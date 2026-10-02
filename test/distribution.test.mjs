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

test('community production entry uses only local AVE credentials and never loads a GMGN client or key store', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.mjs'), 'utf8');
  assert.match(main, /import\s*\{\s*AveClient\s*\}\s*from\s*['"]\.\/ave\.mjs['"]/);
  assert.match(main, /apiKeyProvider:\s*\(\)\s*=>\s*ave\.getKey\(\)/);
  assert.match(main, /verifyData:\s*\(key,\s*options\)\s*=>\s*market\.verifyApiKey\(key,\s*options\)/);
  assert.match(main, /const sharedRequestIntervalMs\s*=\s*5\s*\*\s*60_000/);
  assert.match(main, /minimumGapMs:\s*sharedRequestIntervalMs/);
  assert.match(main, /new Scanner\(\{[^;]+sharedRequestIntervalMs/);
  assert.match(main, /new Scanner\(\{ provider: market/);
  assert.match(main, /new LiveDiscovery\(\{ provider: market/);
  assert.doesNotMatch(main, /(?:import[^;]+from\s*['"]\.\/gmgn|new\s+Gmgn|process\.env\.(?:GMGN|AVE)|saveGmgnKey:|getGmgnOnboarding:)/);
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
