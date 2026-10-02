// A GoPlus reader for the tracking board only.
//
// Why this exists rather than reusing SecondaryValidator: `validate()` warns up
// its second provider and returns a DexScreener market view alongside the
// security verdict. Tracking compares every axis against the reading taken at
// first sighting, so mixing a second market methodology into the same record
// would manufacture deltas that are really source differences. This reader is
// deliberately GoPlus-only: it adds two facts that are *not* market readings —
// holder concentration and a contract-safety verdict — and touches nothing else.
//
// Measured behaviour it is built around (see .workbuddy/数据源支撑性评估.md):
//   - no API key required, ~50-70 ms per read;
//   - ~30 requests per rolling minute, and the ceiling is reported in the BODY,
//     as HTTP 200 with {code:4029,"too many requests"} — not as HTTP 429, so a
//     status-code check alone would call a throttled reader healthy;
//   - holder distribution present for ~67% of tracked BSC leads and ~8% of
//     tracked Solana leads, so the fifth axis is real but sparse by design.
//
// Every failure path returns null. Enrichment is an optional extra on top of a
// discovery row that already stands on its own; it must never be the reason a
// scan fails.

import { summarizeGoPlusRecord } from './secondary.mjs';
import { validTokenAddress } from './address.mjs';

const ENDPOINTS = Object.freeze({ bsc: '56', sol: null });
const DEFAULT_MAX_BYTES = 512 * 1024;

// Base58 mints are case-sensitive, EVM addresses are not; keying must not be
// case-folded globally or two different Solana mints could collide.
function identity(chain, address) {
  const value = String(address ?? '').trim();
  if (!value) return '';
  return /^0x[0-9a-f]{40}$/i.test(value) ? `${chain}:${value.toLowerCase()}` : `${chain}:${value}`;
}

function endpointFor(chain, address) {
  const value = String(address ?? '').trim();
  if (chain === 'sol') return `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(value)}`;
  const chainId = ENDPOINTS[chain];
  if (!chainId) return '';
  return `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(value)}`;
}

// GoPlus nests the record under the token address on EVM and under the mint on
// Solana, and has been seen to return it unwrapped too, so accept all three.
function locate(payload, chain, address) {
  const result = payload?.result;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result)) {
    for (const row of result) {
      const candidate = row?.contract_address || row?.address || row?.mint || '';
      if (candidate && identity(chain, candidate) === identity(chain, address)) return row;
    }
    return result.find(row => row && typeof row === 'object') || null;
  }
  const wanted = identity(chain, address);
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && identity(chain, key) === wanted) return value;
  }
  // Solana answers unwrapped, so the first object value is the record.
  for (const value of Object.values(result)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

export class GoPlusReader {
  constructor({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = 12_000,
    maxResponseBytes = DEFAULT_MAX_BYTES,
    cacheMs = 10 * 60_000,
    maxPerCycle = 8,
    minGapMs = 300,
    cooldownMs = 60_000,
    chains = ['bsc', 'sol']
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 12_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.cacheMs = Math.max(0, Number(cacheMs) || 0);
    this.maxPerCycle = Math.max(0, Number(maxPerCycle) || 0);
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.cooldownMs = Math.max(1_000, Number(cooldownMs) || 60_000);
    this.supported = new Set(chains);
    this.cache = new Map();
    this.usedThisCycle = 0;
    this.retryAt = 0;
    this.lastGapAt = 0;
    this.health = { reads: 0, throttled: 0, failed: 0, cached: 0, lastReadAt: 0, lastErrorCode: '' };
  }

  // Called once per scan so the per-cycle ceiling is measured per cycle, not per
  // process lifetime.
  beginCycle() {
    this.usedThisCycle = 0;
  }

  // A cycle is worth spending on this chain only if there is room left both in
  // the cycle budget and in the upstream's own window.
  available(chain) {
    if (!this.supported.has(chain)) return false;
    if (this.usedThisCycle >= this.maxPerCycle) return false;
    if (this.retryAt > this.now()) return false;
    return true;
  }

  snapshot() {
    return {
      ...this.health,
      usedThisCycle: this.usedThisCycle,
      maxPerCycle: this.maxPerCycle,
      retryAt: this.retryAt,
      cooling: this.retryAt > this.now()
    };
  }

  async #request(url) {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const raw = await response.text();
    if (raw.length > this.maxResponseBytes) {
      const error = new Error('GoPlus response exceeded the size limit');
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error('GoPlus did not return JSON');
      error.code = 'INVALID_JSON';
      throw error;
    }
  }

  // One read. Returns { top10Rate, security } or null, and never throws.
  async read(chain, address) {
    const normalizedChain = String(chain || '').toLowerCase();
    const key = identity(normalizedChain, address);
    if (!key || !this.supported.has(normalizedChain)) return null;
    // A lead whose address would not survive the chain's own validator cannot be
    // looked up, so refuse it before spending a read from the cycle budget.
    if (!validTokenAddress(normalizedChain, String(address ?? '').trim())) return null;

    const cached = this.cache.get(key);
    const at = this.now();
    if (cached && cached.until > at) {
      this.health.cached++;
      return cached.value;
    }
    if (!this.available(normalizedChain)) return null;

    const url = endpointFor(normalizedChain, address);
    if (!url) return null;

    const gap = this.minGapMs - (at - this.lastGapAt);
    if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));

    this.usedThisCycle++;
    this.lastGapAt = this.now();
    this.health.reads++;
    try {
      const payload = await this.#request(url);
      const code = payload?.code;
      if (code !== undefined && ![1, '1'].includes(code)) {
        // 4029 is the throttle. Back the whole reader off rather than letting
        // every remaining lead in this cycle spend a doomed request.
        if (Number(code) === 4029) {
          this.health.throttled++;
          this.retryAt = this.now() + this.cooldownMs;
        } else {
          this.health.failed++;
        }
        this.health.lastErrorCode = String(code);
        return null;
      }
      const record = locate(payload, normalizedChain, address);
      if (!record) {
        this.health.failed++;
        this.health.lastErrorCode = 'NO_RECORD';
        return null;
      }
      const value = { ...summarizeGoPlusRecord(record, normalizedChain), observedAt: this.now() };
      if (this.cacheMs > 0) {
        if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { value, until: this.now() + this.cacheMs });
      }
      this.health.lastReadAt = this.now();
      this.health.lastErrorCode = '';
      return value;
    } catch (error) {
      this.health.failed++;
      this.health.lastErrorCode = String(error?.code || error?.name || 'ERROR');
      return null;
    }
  }

  // Reads a whole batch of leads, honouring the cycle ceiling. Returns a Map
  // keyed exactly as identity() keys, so the caller does not re-derive it.
  async enrich(leads) {
    const out = new Map();
    for (const lead of leads || []) {
      const chain = String(lead?.chain || '').toLowerCase();
      const key = identity(chain, lead?.address);
      if (!key) continue;
      // A cached lead costs nothing, so it is still served once the cycle budget
      // is spent. Without this the leads read first would pin the budget every
      // cycle and the rest of the board would never be enriched.
      const cached = this.cache.get(key);
      if ((!cached || cached.until <= this.now()) && !this.available(chain)) break;
      const value = await this.read(chain, lead?.address);
      if (value) out.set(key, value);
    }
    return out;
  }
}

export const goplusEndpoint = endpointFor;
export const goplusIdentity = identity;
