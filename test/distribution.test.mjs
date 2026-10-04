import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dependenciesReady } from '../scripts/setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This case runs the setup entry through a real child process and captures its
// output. A hardened runner can refuse that plumbing (for example by denying
// pipe creation), so probe with the same stdio the case needs and skip with a
// reason there instead of failing for an environmental cause.
const SPAWN_AVAILABLE = (() => {
  try { execFileSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); return true; }
  catch { return false; }
})();

test('community distribution has platform launchers and excludes private runtime data', () => {
  for (const file of ['安装并启动.command', '安装并启动.bat', 'START-HERE-WINDOWS.bat', 'START-WINDOWS.bat', 'TEST-WINDOWS.bat', 'README-WINDOWS.txt', 'README.md', 'SECURITY.md',
    'THIRD_PARTY_NOTICES.md', 'docs/EDITION-BOUNDARY.md', 'docs/RELEASE-CHECKLIST.md']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const rule of ['state/**', 'logs/**', '.env', '.npmrc']) assert.match(ignore, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('Windows test launcher runs in foreground so it can be stopped cleanly', () => {
  const launcher = fs.readFileSync(path.join(root, 'TEST-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node --use-env-proxy src\\main\.mjs/);
  assert.match(launcher, /start "" \/B node scripts\\wait-and-open\.mjs/i);
  assert.doesNotMatch(launcher, /scripts\\open\.mjs|start[^\r\n]*src\\main\.mjs/i);
});

test('portable Windows launcher uses only its bundled runtime', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/OPEN-MEME-RADAR.bat'), 'utf8');
  assert.match(launcher, /"runtime\\node\.exe" --use-env-proxy scripts\\supervise\.mjs/);
  assert.doesNotMatch(launcher, /where node|npm|powershell/i);
});

test('portable EXE bootstrap only starts the bundled read-only application', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/launcher.cjs'), 'utf8');
  assert.match(launcher, /runtime', 'node\.exe/);
  assert.match(launcher, /src', 'main\.mjs/);
  assert.doesNotMatch(launcher, /https?:|powershell|cmd\.exe|private.?key|swap/i);
});

test('Windows launcher stays local and does not require administrator privileges', () => {
  const launcher = fs.readFileSync(path.join(root, 'START-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node scripts\\open\.mjs/);
  assert.match(launcher, /cd \/d "%~dp0"/);
  assert.doesNotMatch(launcher, /powershell|runas|netsh|reg(?:\.exe)?\s+add/i);
});

test('open-source release metadata uses AGPL and remains blocked from accidental npm publishing', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'AGPL-3.0-only');
  assert.equal(fs.existsSync(path.join(root, 'LICENSE')), true);
});

// AVE is retired as the market source. What this test actually protects is that
// the community entry needs no second credential path and no credential store -
// that clause was already rewritten once on 2026-10-03 when "only an AVE key"
// stopped being the property worth protecting, and it is rewritten again now
// that the source is GMGN. The entry wires one source, reads its key from the
// same local place, and keeps the shared request spacing.
test('community production entry wires one market source with local credentials and loads no credential store', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.mjs'), 'utf8');
  const radar = fs.readFileSync(path.join(root, 'src/gmgn-radar.mjs'), 'utf8');
  assert.match(main, /import\s*\{\s*GmgnRadarSource\s*\}\s*from\s*['"]\.\/gmgn-radar\.mjs['"]/);
  assert.match(main, /const sharedRequestIntervalMs\s*=\s*5\s*\*\s*60_000/);
  assert.match(main, /new Scanner\(\{[^;]+sharedRequestIntervalMs/);
  assert.match(main, /new Scanner\(\{ provider: market/);
  assert.match(main, /new LiveDiscovery\(\{ provider: market/);
  assert.match(main, /new GmgnRadarSource\(\{[^}]*chains/);
  // The one source is the only source: no AVE module, client or key path left.
  assert.doesNotMatch(main, /from\s*['"]\.\/ave(?:-settings)?\.mjs['"]|AveClient|AVE_API_KEY|ave-credentials/);
  // The bucket is shared with the probe, so the floor is a real constraint:
  // 2200 ms between requests, never less.
  assert.match(radar, /minGapMs = 2_200/);
  assert.doesNotMatch(radar, /minGapMs = \d{1,3}\b/);
  assert.doesNotMatch(main, /gmgn-key-store|gmgn-connection|gmgn-readonly-worker|saveGmgnKey|getGmgnOnboarding|GMGN_PRIVATE_KEY/);
});

test('clean setup and doctor work offline without npm, installed modules, credentials or state',
  { skip: SPAWN_AVAILABLE ? false : 'child processes are unavailable in this environment' }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-setup-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'scripts'));
  for (const name of ['package.json', 'package-lock.json', 'scripts/setup.mjs']) {
    fs.copyFileSync(path.join(root, name), path.join(temporary, name));
  }
  assert.equal(await dependenciesReady(temporary), true);
  for (const args of [[], ['--check']]) {
    const output = execFileSync(process.execPath, [path.join(temporary, 'scripts/setup.mjs'), ...args], {
      cwd: temporary, env: { PATH: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.match(output, /运行环境已就绪/);
  }
  for (const name of ['node_modules', 'state', 'logs', '.runtime']) assert.equal(fs.existsSync(path.join(temporary, name)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(temporary, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ ...manifest, dependencies: { 'obsolete-fixture': '1.0.0' } }));
  assert.equal(await dependenciesReady(temporary), false, 'a dependency-bearing package must not pass the zero-dependency check');
});
