import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLocalLock } from '../scripts/setup.mjs';

const name = 'supervisor-3791';
// A symbolic link is one of the attack shapes this suite must reject, but
// creating one is privileged on Windows and some hardened runners refuse it
// outright. Detect the capability once so the case is reported as not
// applicable instead of as a failure.
const SYMLINK_AVAILABLE = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-symlink-probe-'));
  try {
    const target = path.join(directory, 'target'), link = path.join(directory, 'link');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, link);
    return fs.lstatSync(link).isSymbolicLink();
  } catch { return false; }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
})();
const dead = () => { throw Object.assign(new Error('no process'), { code: 'ESRCH' }); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-local-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.runtime'), lock = path.join(runtime, `${name}.lock`);
  fs.mkdirSync(runtime);
  return { root, runtime, lock, recovery: `${lock}.recovery`, pid: 12345, attempts: 12, pause: async () => {}, kill: dead };
}

test('owner is complete and synced before atomic publication, and only the owned lock is released', async t => {
  const value = fixture(t); let synced = false, entered = false;
  const fsImpl = { ...fs, fsyncSync(fd) { fs.fsyncSync(fd); synced = true; }, linkSync(from, to) {
    assert.equal(synced, true); assert.equal(fs.readFileSync(from, 'utf8'), '12345\n'); fs.linkSync(from, to);
  } };
  assert.equal(await withLocalLock(name, async () => {
    entered = true;
    assert.equal(fs.lstatSync(value.lock).isFile(), true);
    // The temp file the owner was hard-linked from must be gone, which leaves a
    // single link. Windows keeps reporting the pre-unlink count until the handle
    // is released, so the directory listing below carries the same proof there.
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(value.lock).nlink, 1);
    assert.deepEqual(fs.readdirSync(value.runtime), [`${name}.lock`]);
    return 'owned';
  }, { ...value, fsImpl }), 'owned');
  assert.equal(entered, true); assert.deepEqual(fs.readdirSync(value.runtime), []);
});

test('crash/write/link failure before publication leaves no ownerless held lock', async t => {
  for (const operation of ['writeFileSync', 'fsyncSync', 'linkSync']) {
    const value = fixture(t), fsImpl = { ...fs, [operation]() { throw Object.assign(new Error('private error'), { code: 'EACCES' }); } };
    await assert.rejects(withLocalLock(name, () => assert.fail('not acquired'), { ...value, fsImpl }), { code: 'RADAR_LOCK_IO' });
    assert.deepEqual(fs.readdirSync(value.runtime), [], operation);
    await withLocalLock(name, () => {}, value);
  }
});

test('confirmed dead file and legacy directory owners are recovered under a separate reaper guard', async t => {
  for (const legacy of [false, true]) {
    const value = fixture(t);
    if (legacy) fs.mkdirSync(value.lock);
    fs.writeFileSync(legacy ? path.join(value.lock, 'pid') : value.lock, '901');
    const fsImpl = { ...fs, unlinkSync(file) {
      if (file === value.lock || file === path.join(value.lock, 'pid')) {
        const owner = fs.readFileSync(file, 'utf8').trim();
        if (owner === '901') assert.equal(fs.readFileSync(value.recovery, 'utf8').trim(), '12345');
      }
      fs.unlinkSync(file);
    } };
    await withLocalLock(name, () => {}, { ...value, fsImpl });
    assert.deepEqual(fs.readdirSync(value.runtime), []);
  }
});

test('live, permission-denied and uncertain owners are never reclaimed', async t => {
  for (const code of [null, 'EPERM', 'EACCES', 'UNKNOWN']) {
    const value = fixture(t); fs.writeFileSync(value.lock, '901');
    const kill = () => { if (code) throw Object.assign(new Error('cannot prove death'), { code }); };
    await assert.rejects(withLocalLock(name, () => assert.fail('live owner'), { ...value, kill, attempts: 2 }), { code: 'RADAR_LOCK_BUSY' });
    assert.equal(fs.readFileSync(value.lock, 'utf8'), '901');
    assert.deepEqual(fs.readdirSync(value.runtime), [`${name}.lock`]);
  }
});

test('concurrent callers serialize their callbacks without removing the live owner', async t => {
  const value = fixture(t); let releaseFirst, releaseWaiter, signalWaiting, active = 0, maximum = 0;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const waiting = new Promise(resolve => { signalWaiting = resolve; });
  const paused = new Promise(resolve => { releaseWaiter = resolve; });
  const options = { ...value, pid: process.pid, kill: process.kill,
    pause: async () => { signalWaiting(); await paused; } };
  const first = withLocalLock(name, async () => {
    maximum = Math.max(maximum, ++active); await held; active--;
  }, options);
  const second = withLocalLock(name, async () => {
    maximum = Math.max(maximum, ++active); active--;
  }, options);
  await waiting;
  assert.equal(active, 1); assert.equal(fs.readFileSync(value.lock, 'utf8').trim(), String(process.pid));
  releaseFirst(); await first; releaseWaiter(); await second;
  assert.equal(maximum, 1); assert.deepEqual(fs.readdirSync(value.runtime), []);
});

test('legacy creation receives a short grace period while ownerless remnants fail explicitly without deletion', async t => {
  const value = fixture(t); fs.mkdirSync(value.lock); let pauses = 0;
  await assert.rejects(withLocalLock(name, () => assert.fail('unknown owner'), { ...value,
    pause: async () => { pauses++; } }), { code: 'RADAR_LOCK_ORPHAN' });
  assert.equal(pauses, 9); assert.deepEqual(fs.readdirSync(value.lock), []);
  const pending = fixture(t); fs.mkdirSync(pending.lock);
  await withLocalLock(name, () => {}, { ...pending, pause: async () => {
    fs.writeFileSync(path.join(pending.lock, 'pid'), '901');
  } });
  assert.deepEqual(fs.readdirSync(pending.runtime), []);
});

test('competing reapers recheck ownership and cannot remove a newly acquired live replacement', async t => {
  const value = fixture(t); fs.writeFileSync(value.lock, '901'); let replaced = false;
  const fsImpl = { ...fs, linkSync(from, to) {
    if (to === value.recovery && !replaced) {
      // Another contender finished its recovery and acquired before this
      // contender obtained the recovery guard.
      fs.unlinkSync(value.lock); fs.writeFileSync(value.lock, '902'); replaced = true;
    }
    fs.linkSync(from, to);
  } };
  const kill = owner => { if (owner !== 902) dead(); };
  await assert.rejects(withLocalLock(name, () => assert.fail('replacement is live'),
    { ...value, fsImpl, kill, attempts: 3 }), { code: 'RADAR_LOCK_BUSY' });
  assert.equal(fs.readFileSync(value.lock, 'utf8'), '902');
  assert.equal(fs.existsSync(value.recovery), false);
});

test('a crashed recovery guard is not stolen and its exact location is reported', async t => {
  const value = fixture(t); fs.writeFileSync(value.lock, '901'); fs.writeFileSync(value.recovery, '902');
  await assert.rejects(withLocalLock(name, () => assert.fail('ambiguous recovery'), value), error => {
    assert.equal(error.code, 'RADAR_LOCK_RECOVERY');
    assert.match(error.message, /\.runtime\/supervisor-3791\.lock\.recovery/);
    assert.match(error.message, /不要删除整个/); return true;
  });
  assert.equal(fs.readFileSync(value.lock, 'utf8'), '901');
  assert.equal(fs.readFileSync(value.recovery, 'utf8'), '902');
});

test('callback errors retain their meaning and a replaced lock is never deleted during release', async t => {
  const value = fixture(t), problem = new Error('application failed');
  await assert.rejects(withLocalLock(name, () => { throw problem; }, value), error => error === problem);
  assert.equal(fs.existsSync(value.lock), false);
  await assert.rejects(withLocalLock(name, () => {
    fs.renameSync(value.lock, value.lock + '.old'); fs.writeFileSync(value.lock, '902');
  }, value), { code: 'RADAR_LOCK_CHANGED' });
  assert.equal(fs.readFileSync(value.lock, 'utf8'), '902');
});

test('linked runtime paths and linked owners are rejected without following them',
  { skip: SYMLINK_AVAILABLE ? false : 'symbolic links cannot be created in this environment' }, async t => {
  const value = fixture(t), outside = path.join(value.root, 'outside'); fs.mkdirSync(outside);
  fs.rmdirSync(value.runtime); fs.symlinkSync(outside, value.runtime);
  await assert.rejects(withLocalLock(name, () => {}, value), { code: 'RADAR_LOCK_UNSAFE' });
  assert.deepEqual(fs.readdirSync(outside), []);
  const linked = fixture(t), target = path.join(linked.root, 'private-pid'); fs.writeFileSync(target, '901');
  fs.symlinkSync(target, linked.lock);
  await assert.rejects(withLocalLock(name, () => {}, linked), { code: 'RADAR_LOCK_UNSAFE' });
  assert.equal(fs.readFileSync(target, 'utf8'), '901');
});
