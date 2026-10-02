import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION_FILES = Object.freeze([
  // The key is committed last so a partial copy cannot enable scanning before
  // its existing cumulative budget is safely present in the destination.
  'ave-read-budget.json', 'preferences.json', 'preferences.json.bak', 'radar.json', 'radar.json.bak', 'ave-credentials.json',
]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function plainDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('MIGRATION_PATH', '请选择真实的雷达目录，不支持符号链接。');
}
function plainFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    fail('MIGRATION_FILE', '本机资料包含链接、异常类型或过大的文件，迁移已停止。');
  }
  return stat;
}
function applicationRoot(input) {
  if (!input || typeof input !== 'string') fail('MIGRATION_INPUT', '必须明确指定旧版雷达目录。');
  const directory = path.resolve(input);
  plainDirectory(directory);
  const manifest = path.join(directory, 'package.json');
  plainFile(manifest, 262144);
  let value;
  try { value = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { fail('MIGRATION_APP', '所选目录不是可识别的雷达安装。'); }
  if (value?.name !== 'meme-radar-open-source') fail('MIGRATION_APP', '所选目录不是 Meme雷达开源版；未读取其中的本机资料。');
  return fs.realpathSync(directory);
}
// The ledger lock is an owner record (`pid:token`), not an empty flag, so its
// holder can be inspected instead of assumed. Mirrors the reclaim rules in
// src/ave.mjs: only a provably live writer blocks the migration, and a legacy
// empty lock is honored until it is provably ancient. The lock file itself is
// never removed here, because the source directory is promised to stay intact.
const LEDGER_LOCK_STALE_MS = 120_000;
const LEDGER_LOCK_OWNER = /^([0-9]+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertLedgerReleased(state) {
  const lock = path.join(state, 'ave-read-budget.lock');
  let stat;
  try { stat = fs.lstatSync(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128) {
    let text = null;
    try { text = fs.readFileSync(lock, 'utf8').trim(); } catch { /* Unreadable: fall through to the age check. */ }
    const owner = text === null ? null : LEDGER_LOCK_OWNER.exec(text)?.[1];
    if (owner !== undefined && owner !== null) {
      let alive = true;
      try { process.kill(Number(owner), 0); }
      catch (error) { alive = error.code !== 'ESRCH'; } // Only ESRCH proves the writer is gone.
      if (!alive || stat.mtimeMs + LEDGER_LOCK_STALE_MS <= Date.now()) return;
    }
  }
  if (stat.mtimeMs + LEDGER_LOCK_STALE_MS > Date.now()) {
    fail('MIGRATION_BUSY', '旧版额度账本仍有写入锁，请确认程序已关闭后再试。');
  }
}

function assertStopped(root) {
  const runtime = path.join(root, '.runtime');
  if (!exists(runtime)) return;
  plainDirectory(runtime);
  for (const name of fs.readdirSync(runtime)) {
    if (!/^supervisor-\d+\.lock$/.test(name)) continue;
    const lock = path.join(runtime, name), stat = fs.lstatSync(lock);
    // New locks publish a complete PID file atomically. Keep recognizing old
    // directory/pid locks; a still-linked publish file fails plainFile below.
    if (stat.isSymbolicLink()) fail('MIGRATION_FILE', '启动锁含有链接，无法确认程序已关闭。');
    if (!stat.isFile()) plainDirectory(lock);
    const owner = stat.isFile() ? lock : path.join(lock, 'pid');
    if (!exists(owner)) fail('MIGRATION_BUSY', '存在未完成的启动任务，请先关闭新旧雷达。');
    plainFile(owner, 64);
    const pid = Number(fs.readFileSync(owner, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) fail('MIGRATION_BUSY', '启动锁无法确认，请保留原目录并先检查。');
    try { process.kill(pid, 0); fail('MIGRATION_BUSY', '雷达仍在运行，请先关闭新旧雷达再迁移。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function migrateLocalState({ from, to = currentRoot, confirmedStopped = false } = {}) {
  if (!confirmedStopped) fail('MIGRATION_CONFIRM', '请先关闭新旧雷达，再使用 --confirm-stopped 明确确认。');
  const source = applicationRoot(from), destination = applicationRoot(to);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) {
    fail('MIGRATION_PATH', '新旧安装须为两个独立目录，不能相同或相互嵌套。');
  }
  const sourceState = path.join(source, 'state'), destinationState = path.join(destination, 'state');
  if (exists(destinationState)) fail('MIGRATION_EXISTS', '新目录已有 state，未覆盖任何资料；请使用尚未启动的新解压目录。');
  plainDirectory(sourceState); assertStopped(source); assertStopped(destination);
  assertLedgerReleased(sourceState);
  const snapshots = []; let bytes = 0;
  for (const name of MIGRATION_FILES) {
    const file = path.join(sourceState, name);
    if (!exists(file)) continue;
    const stat = plainFile(file, name === 'ave-credentials.json' ? 4096 : 64 * 1024 * 1024);
    const data = fs.readFileSync(file);
    if ((bytes += data.length) > 128 * 1024 * 1024) fail('MIGRATION_SIZE', '本机资料过大，未写入新目录。');
    let value;
    try { value = JSON.parse(data); } catch { fail('MIGRATION_JSON', '本机资料有损坏或无效 JSON；原文件保留，未尝试修复。'); }
    if (!object(value)) fail('MIGRATION_JSON', '本机资料格式异常；原文件保留。');
    snapshots.push({ name, file, stat, data });
  }
  if (!snapshots.length) fail('MIGRATION_EMPTY', '旧目录没有可迁移的 AVE 配置或记录。');
  if (snapshots.some(row => row.name === 'ave-credentials.json') && !snapshots.some(row => row.name === 'ave-read-budget.json')) {
    fail('MIGRATION_BUDGET', '旧目录有 AVE Key 但缺少额度账本；为避免累计用量重置，未迁移任何文件。');
  }
  for (const row of snapshots) {
    const current = plainFile(row.file, 64 * 1024 * 1024);
    if (current.dev !== row.stat.dev || current.ino !== row.stat.ino || current.size !== row.stat.size
      || current.mtimeMs !== row.stat.mtimeMs || current.ctimeMs !== row.stat.ctimeMs) {
      fail('MIGRATION_CHANGED', '旧目录资料在读取时发生变化；请关闭雷达后重试。');
    }
  }
  assertStopped(source); assertStopped(destination);
  // mkdir is exclusive, and every file is opened with wx. Existing target
  // state is never replaced, even if another process creates it after checks.
  let created = false;
  try {
    fs.mkdirSync(destinationState, { mode: 0o700 }); created = true;
    for (const row of snapshots) {
      const target = path.join(destinationState, row.name);
      const fd = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(fd, row.data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } catch (error) {
    if (!created && error.code === 'EEXIST') fail('MIGRATION_EXISTS', '新目录已出现 state，未覆盖任何资料。');
    fail('MIGRATION_WRITE', '迁移写入未完成；旧目录未改变，新目录可能有部分副本，请勿启动它并保留两个目录检查。');
  }
  return { copied: snapshots.map(row => row.name), originalPreserved: true };
}

export function parseMigrationArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--confirm-stopped' && !result.confirmedStopped) { result.confirmedStopped = true; continue; }
    if (!['--from', '--to'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--') || result[flag.slice(2)]) {
      fail('MIGRATION_INPUT', '用法：node scripts/migrate-local-state.mjs --from <旧版目录> [--to <新目录>] --confirm-stopped');
    }
    result[flag.slice(2)] = argv[++index];
  }
  if (!result.from) fail('MIGRATION_INPUT', '必须使用 --from 明确指定旧版目录；不会自动寻找本机资料。');
  return result;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const result = migrateLocalState(parseMigrationArgs(process.argv.slice(2)));
    console.log(`迁移完成：已复制 ${result.copied.length} 个已知配置/记录文件，原目录未改变。请保留旧目录并手动启动新版。`);
  } catch (error) {
    // Never print filesystem exceptions or JSON contents: either can contain
    // private paths or credential material from a malformed file.
    console.error(error?.code?.startsWith('MIGRATION_') ? error.message : '无法安全迁移本机资料；请检查所选目录与权限，原目录保留。');
    process.exitCode = 1;
  }
}
