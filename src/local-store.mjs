import fs from 'node:fs';
import path from 'node:path';
import { validTokenAddress } from './address.mjs';
import crypto from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // Only valid JSON can replace the last known good backup.
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, `${file}.bak`);
        fs.chmodSync(`${file}.bak`, 0o600);
      } catch {}
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function readJsonWithBackup(file, fallback) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { value: structuredClone(fallback), recovered: false };
  for (const [target, recovered] of [[file, false], [`${file}.bak`, true]]) {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return { value, recovered };
    } catch {}
  }
  // Do not overwrite unreadable user history with a silent empty reset.
  throw Object.assign(new Error('本地记录与备份均无法读取，请保留文件后检查。'), { code: 'STATE_CORRUPT' });
}

export function tokenKey(chain, address) {
  const value = String(address || '').trim();
  return `${chain}:${chain === 'sol' ? value : value.toLowerCase()}`;
}

export class RadarControls {
  constructor(dir, chains, initialChain) {
    this.file = path.join(dir, 'preferences.json');
    this.chains = chains;
    // Both supported chains are watched from the first run. A single-chain
    // default is not a smaller product, it is half of one: the chain that is
    // left out is never requested, so its side of the board is not stale, it is
    // frozen at whenever it was last scanned, and nothing on the board says so.
    // Measured: with Solana switched off, its six tracked leads were a full day
    // old while the BSC half refreshed every eight minutes, and the only hint
    // was a chain switcher a reader had no reason to open.
    //
    // The real cost is that the provider's request spacing is shared, so both
    // chains are scanned half as often as one would be. That is a trade a reader
    // can see and undo in one click; a silently unwatched chain is not.
    const defaults = { enabledChains: [...chains].slice(0, 3), annotations: {} };
    this.value = { ...defaults, ...readJsonWithBackup(this.file, defaults).value };
    this.value.enabledChains = [...new Set(this.value.enabledChains)].filter(x => chains.includes(x)).slice(0, 3);
    if (!this.value.enabledChains.length) this.value.enabledChains = [initialChain];
  }
  setChains(chains) {
    if (!Array.isArray(chains) || !chains.length || chains.length > 3 || new Set(chains).size !== chains.length || chains.some(x => !this.chains.includes(x))) {
      throw Object.assign(new Error('invalid_selection'), { statusCode: 400 });
    }
    this.value.enabledChains = [...chains];
    atomicJson(this.file, this.value);
    return { enabledChains: this.value.enabledChains };
  }
  annotate({ chain, address, favorite, note }) {
    if (!this.chains.includes(chain) || !validTokenAddress(chain, address)
      || typeof favorite !== 'boolean' || typeof note !== 'string' || note.length > 500) {
      throw Object.assign(new Error('invalid_annotation'), { statusCode: 400 });
    }
    const key = tokenKey(chain, address);
    if (favorite && !this.value.annotations[key]?.favorite && Object.values(this.value.annotations).filter(row => row.favorite).length >= 50) {
      throw Object.assign(new Error('favorite_limit'), { statusCode: 400 });
    }
    if (!this.value.annotations[key] && Object.keys(this.value.annotations).length >= 500) throw Object.assign(new Error('annotation_limit'), { statusCode: 400 });
    this.value.annotations[key] = { chain, address, favorite, note: note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''), updatedAt: Date.now() };
    if (!favorite && !note.trim()) delete this.value.annotations[key];
    atomicJson(this.file, this.value);
    return { saved: true };
  }
}
