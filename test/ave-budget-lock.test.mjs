import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAveBudgetStore } from '../src/ave.mjs';

const AT = Date.UTC(2026, 8, 21, 12, 0, 0);
const ledger = () => ({ budgetVersion: 2, day: '2026-09-21', dailyUsed: 0, hourStartedAt: AT, hourlyUsed: 0,
  totalUsed: 0, periodStartedAt: AT, legacyUsageIncluded: false, legacySnapshot: null,
  blockedUntil: 0, quotaUntil: 0, nextRequestAt: 0 });
// A PID above every platform's pid_max, so liveness can never be inferred from
// the clock: this fixture only passes if the ESRCH proof itself is honoured.
const deadPid = () => {
  const pid = 2147483647;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '需要一个可证明已不存在的 PID');
  return pid;
};
const age = (path, ms) => { const old = new Date(Date.now() - ms); utimesSync(path, old, old); };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ave-budget-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'ave-read-budget.json'),
    lock: join(directory, 'ave-read-budget.lock'), store: createAveBudgetStore(directory) };
}

test('a lock left behind by a killed process is reclaimed instead of blocking the ledger forever', t => {
  const f = fixture(t);
  writeFileSync(f.lock, `${deadPid()}:${randomUUID()}\n`);
  assert.equal(f.store.transact(() => ledger()).budgetVersion, 2);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).totalUsed, 0);
  assert.equal(existsSync(f.lock), false, 'the reclaimer must also release its own lock');
});

test('a legacy empty lock stays fail-closed until it is provably ancient, then is reclaimed', t => {
  const f = fixture(t);
  writeFileSync(f.lock, '');
  // A fresh ownerless record may still be a peer that is mid-write, so age is
  // the only proof available for a format that never carried an owner.
  assert.throws(() => f.store.transact(() => ledger()), { code: 'AVE_BUDGET_STORE' });
  assert.equal(existsSync(f.file), false);
  age(f.lock, 10 * 60000);
  f.store.transact(() => ledger());
  assert.equal(existsSync(f.lock), false);
});

test('a record this process wrote and could not remove is taken over instead of wedging the ledger', t => {
  const f = fixture(t);
  f.store.transact(() => ledger());
  assert.equal(existsSync(f.lock), false, 'a completed transaction releases its own lock');
  // What a refused delete leaves behind: an owner record naming this process. It
  // has no live owner - a record naming this process can only have been written
  // by this process, and the store's critical section is synchronous - so the
  // age rule cannot be the only way back, because reclaiming by age needs the
  // very delete that was refused. The takeover overwrites it instead.
  writeFileSync(f.lock, `${process.pid}:${randomUUID()}\n`);
  assert.equal(f.store.transact(() => ledger()).budgetVersion, 2);
  assert.equal(existsSync(f.lock), false, 'the taken-over record is released again');
});

test('a lock held by another live process is never stolen and its record is preserved verbatim', t => {
  const f = fixture(t);
  // A PID that is alive and is not this one. The own-process takeover must not
  // extend to a record anybody else wrote, so this process's own PID - alive and
  // convenient, but exactly the case that IS taken over - would not test it.
  assert.notEqual(process.ppid, process.pid, 'the fixture needs a process that is not this one');
  const held = `${process.ppid}:${randomUUID()}\n`;
  writeFileSync(f.lock, held);
  assert.throws(() => f.store.transact(() => ledger()), { code: 'AVE_BUDGET_STORE' });
  assert.equal(readFileSync(f.lock, 'utf8'), held);
  assert.equal(existsSync(f.file), false);
});

test('a wedged holder past the staleness bound is reclaimed even though its pid may be reused', t => {
  const f = fixture(t);
  // A lock naming this process may equally belong to a dead process whose PID we
  // inherited; the takeover covers that without waiting for the age bound, and
  // the bound still covers a record this process never wrote.
  writeFileSync(f.lock, `${process.pid}:${randomUUID()}\n`);
  age(f.lock, 10 * 60000);
  f.store.transact(() => ledger());
  assert.equal(existsSync(f.lock), false);
});

test('release never deletes a lock record that replaced its own while the transaction ran', t => {
  const f = fixture(t);
  const successor = `999999:${randomUUID()}\n`;
  f.store.transact(() => { writeFileSync(f.lock, successor); return ledger(); });
  assert.equal(readFileSync(f.lock, 'utf8'), successor);
});

test('a symlink planted at the lock path fails closed instead of being unlinked', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'target'), 'x');
  symlinkSync(join(f.directory, 'target'), f.lock);
  assert.throws(() => f.store.transact(() => ledger()), { code: 'AVE_BUDGET_STORE' });
  assert.equal(readFileSync(join(f.directory, 'target'), 'utf8'), 'x');
});
