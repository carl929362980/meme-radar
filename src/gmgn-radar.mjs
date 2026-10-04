// The candidate radar's water supply.
//
// Why this is its own module rather than a branch inside src/ave.mjs: the radar
// used to be fed by AVE's trending cache alone, and that client paces itself by
// sleeping *inside* the request lane - `src/ave.mjs` awaits
// `Math.max(0, lane.nextStart - now)` before it will issue anything, where
// `nextStart` is `now + spacing(rateControl)` and `spacing` had climbed to its
// 15-minute ceiling. A single discovery read could therefore hold the whole scan
// cycle open for a quarter of an hour: `scanInProgress` stayed true, `status`
// stayed SCANNING, and every stage after discovery - including the outcome
// read-back - never ran. Measured on 2026-10-04: `lastCycleMs` 903544 against a
// previous cycle of 2645 ms.
//
// The GMGN client has no such inline wait: a read that is not currently allowed
// returns nothing and the caller keeps going. So retiring AVE as the discovery
// source is also what unblocks the cycle, and the two are not separable.
//
// Nothing here blocks for minutes, and nothing here invents a number. A field
// the route did not answer is null, never 0.
import { GmgnClient, loadApiKey } from './gmgn.mjs';
import { config } from './config.mjs';
import { validTokenAddress } from './address.mjs';

export const RADAR_PROVIDER = 'GMGN';

// One route per chain, measured rather than chosen:
//   trending  GET /v1/market/rank, weight 1. Ordered by creation timestamp it is
//             the only route that returns pools young enough to be worth
//             watching on either chain - measured 2026-10-04, BSC 32/50 in the
//             10k-150k band with the youngest at 14 s, SOL 14/50 with the
//             youngest at 60 s. The default ordering hands back old pools, so
//             `order_by=creation_timestamp` is not an optimisation, it is the
//             difference between a radar and a list of last week's coins.
//   trenches  POST /v1/trenches, weight 3. SOL's launchpad feed, ordered
//             newest-first, the only place a pool seconds old appears. Its rows
//             are market-cap infants (median about 3.5k on Solana), so most of
//             them sit under the discovery band - they are reported, not hidden,
//             and counted rather than dropped.
export const RADAR_PLANS = Object.freeze({
  sol: Object.freeze({
    trenches: Object.freeze({ types: Object.freeze(['new_creation']),
      filters: Object.freeze({ max_created: '30m', min_liquidity: 100 }) }),
    trending: true
  }),
  bsc: Object.freeze({
    trenches: Object.freeze({ types: Object.freeze(['near_completion']),
      // rugRatio is deliberately not filtered on: this chain's trenches
      // response does not carry it at all, and a filter on an absent field
      // would advertise a gate that silently is not there.
      filters: Object.freeze({ min_liquidity: 100 }) }),
    trending: true
  })
});

export const TRENDING_LIMIT = 50;
// How old a discovery sample may be before a passive read goes and gets a new
// one. The radar is the page's live surface, so a five-minute-old sample reads
// as a dead feed; at this cadence both chains cost about eight weight a minute
// against a bucket that allows twenty a second.
export const RADAR_REFRESH_MS = 45_000;

const number = (value) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = (value) => { const parsed = number(value); return parsed !== null && parsed > 0 ? parsed : null; };
const rate = (value) => { const parsed = number(value); return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null; };
const flag = (value) => (typeof value === 'boolean' ? value : null);
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

// The rank route answers `volume`, `swaps`, `buys` and `sells` without naming a
// window, so they are carried under their own names and never as a five-minute
// or one-hour counter. Renaming them would be the one falsification this
// project's no-mixed-rulers rule exists to prevent: a downstream change-rate
// would then divide an unknown span by a named one.
export function normalizeTrendingRow(row, chain, at) {
  if (!row || typeof row !== 'object') return null;
  const address = typeof row.address === 'string' ? row.address.trim() : '';
  if (!validTokenAddress(chain, address)) return null;
  const created = positive(row.creation_timestamp ?? row.open_timestamp);
  return {
    marketProvider: RADAR_PROVIDER, source: 'GMGN', route: 'trending', chain, address,
    symbol: text(row.symbol, 30), name: text(row.name, 80),
    price: positive(row.price),
    market_cap: positive(row.market_cap ?? row.usd_market_cap),
    liquidity: number(row.liquidity),
    holder_count: number(row.holder_count),
    creation_timestamp: created,
    open_timestamp: positive(row.open_timestamp),
    // Risk facts this route does publish. Each one stays null when the row does
    // not carry it, which is what lets the screen say "not assessed" instead of
    // "clear".
    rug_ratio: rate(row.rug_ratio),
    bundler_rate: rate(row.bundler_rate ?? row.bundler_trader_amount_rate),
    rat_trader_amount_rate: rate(row.rat_trader_amount_rate),
    is_wash_trading: flag(row.is_wash_trading),
    top_10_holder_rate: rate(row.top_10_holder_rate),
    sniper_count: number(row.sniper_count),
    smart_degen_count: number(row.smart_degen_count),
    // Not published by this route, and not guessed.
    is_honeypot: null,
    volume_5m: null, buys_5m: null, sells_5m: null, activityWindow: null,
    website: text(row.website, 200), twitter_username: text(row.twitter_username, 80),
    launchpad: text(row.launchpad ?? row.launchpad_platform, 40),
    sourceUpdatedAt: at, capturedAt: at
  };
}

// Same neutral shape, from the trenches route. That route is camelCase and
// pool-scoped; the mapping is one-to-one on purpose so one screen grades both
// and no caller has to know which route a row came from.
export function normalizeTrenchesRadarRow(row, chain, at) {
  if (!row || typeof row !== 'object') return null;
  const address = typeof row.address === 'string' ? row.address.trim() : '';
  if (!validTokenAddress(chain, address)) return null;
  return {
    marketProvider: RADAR_PROVIDER, source: 'GMGN', route: 'trenches', chain, address,
    symbol: text(row.symbol, 30), name: text(row.name ?? row.trans_symbol_zhcn, 80),
    price: positive(row.price),
    market_cap: positive(row.market_cap ?? row.usd_market_cap),
    liquidity: number(row.liquidity),
    holder_count: number(row.holder_count),
    creation_timestamp: positive(row.created_timestamp ?? row.open_timestamp ?? row.createdAt),
    open_timestamp: positive(row.open_timestamp),
    rug_ratio: rate(row.rug_ratio),
    bundler_rate: rate(row.bundler_rate ?? row.bundler_trader_amount_rate),
    rat_trader_amount_rate: rate(row.rat_trader_amount_rate ?? row.ratTraderRate),
    is_wash_trading: flag(row.is_wash_trading ?? row.washTrading),
    top_10_holder_rate: rate(row.top_10_holder_rate ?? row.top10Rate),
    sniper_count: number(row.sniper_count),
    smart_degen_count: number(row.smart_degen_count ?? row.smartMoneyCount),
    is_honeypot: null,
    volume_5m: null, buys_5m: null, sells_5m: null, activityWindow: null,
    website: text(row.website, 200), twitter_username: text(row.twitter, 80),
    launchpad: text(row.launchpad, 40),
    sourceUpdatedAt: at, capturedAt: at
  };
}

function dedupe(rows) {
  const byAddress = new Map();
  for (const row of rows) {
    if (!row?.address) continue;
    // The rank route wins on a collision: it is the one that carries a completed
    // market reading, while a trenches row for the same mint is a snapshot of a
    // pool still forming.
    const existing = byAddress.get(row.address);
    if (!existing || (existing.route === 'trenches' && row.route === 'trending')) byAddress.set(row.address, row);
  }
  return [...byAddress.values()];
}

export class GmgnRadarSource {
  constructor({ client = null, apiKey = loadApiKey(), settings = config, now = () => Date.now(),
    refreshMs = RADAR_REFRESH_MS, chains = null, minGapMs = 2_200 } = {}) {
    this.client = client || new GmgnClient({ apiKey, minGapMs });
    this.settings = settings;
    this.now = now;
    this.refreshMs = Math.max(5_000, Number(refreshMs) || RADAR_REFRESH_MS);
    this.chains = (Array.isArray(chains) && chains.length ? chains : settings.supportedChains || ['sol', 'bsc'])
      .filter((chain) => RADAR_PLANS[chain]);
    // No credential can rotate under us - this provider takes an API key from
    // the environment or the CLI's own file and has no settings screen - so the
    // epoch never advances. Callers still read it, and a constant is the honest
    // answer rather than a counter that implies a rotation that cannot happen.
    this.keyEpoch = 0;
    this.disabled = false;
    this.metrics = { requests: 0, cacheHits: 0, rateLimits: 0, failures: 0, byRoute: {} };
    this.lastDiscoveryHealth = null;
    this.#samples = new Map();
    this.#inflight = new Map();
  }

  #samples;
  #inflight;

  get nextAllowedAt() {
    const snapshot = this.client.snapshot?.() || {};
    const next = Math.max(Number(snapshot.retryAt) || 0, Number(snapshot.nextAllowedAt) || 0);
    return Number.isFinite(next) && next > 0 ? next : 0;
  }

  // A provider that needs no per-install credential. It is not "configured by
  // the user", it is either keyed or it is not, and the scanner reports which.
  async configured() {
    return Boolean(this.client?.enabled) && !this.client.cooling?.();
  }

  cooling() {
    return Boolean(this.client?.cooling?.());
  }

  snapshot() {
    const health = this.client.snapshot?.() || {};
    return {
      provider: RADAR_PROVIDER,
      enabled: Boolean(this.client?.enabled),
      // There is no deep-audit route on this provider and pretending otherwise
      // would let the audit stage spend a cycle discovering that. It is stated
      // here so the scanner breaks out of that stage immediately and the
      // projection can say so instead of showing an empty table.
      recovery: { auditAllowed: false },
      nextAllowedAt: this.nextAllowedAt,
      pauseCode: this.client?.cooling?.() ? 'SOURCE_COOLING' : null,
      requests: Number(health.requests) || 0,
      ok: Number(health.ok) || 0,
      failed: Number(health.failed) || 0,
      throttled: Number(health.throttled) || 0,
      banned: Number(health.banned) || 0,
      lastErrorCode: String(health.lastErrorCode || ''),
      lastOkAt: Number(health.lastOkAt) || 0
    };
  }

  // Never throws, never waits longer than the route's own timeout. A read that
  // the bucket will not allow right now returns null; the caller keeps what it
  // already has. This is the property AVE's lane did not have.
  async #readRoute(route, chain, plan) {
    const at = this.now();
    let rows = null;
    if (route === 'trending') {
      const payload = await this.client.request('trending',
        { query: { chain, order_by: 'creation_timestamp', limit: TRENDING_LIMIT } });
      const list = Array.isArray(payload?.rank) ? payload.rank : [];
      rows = list.map((row) => normalizeTrendingRow(row, chain, at)).filter(Boolean);
    } else {
      const trenchPlan = plan.trenches || {};
      const list = await this.client.trenches(chain, { types: [...(trenchPlan.types || [])], filters: { ...(trenchPlan.filters || {}) } });
      rows = (Array.isArray(list) ? list : []).map((row) => normalizeTrenchesRadarRow(row, chain, at)).filter(Boolean);
    }
    this.metrics.requests++;
    return rows;
  }

  async #refresh(chain) {
    const plan = RADAR_PLANS[chain];
    if (!plan) return null;
    const pending = this.#inflight.get(chain);
    if (pending) return pending;
      const job = (async () => {
        const at = this.now();
        const results = [];
        let failed = 0;
        for (const route of ['trending', 'trenches']) {
        if (route === 'trenches' && !plan.trenches) continue;
        if (route === 'trending' && !plan.trending) continue;
        let rows = null;
        try { rows = await this.#readRoute(route, chain, plan); }
        catch { rows = null; }
        if (rows === null) { this.metrics.failures++; failed++; continue; }
        this.metrics.byRoute[route] = (this.metrics.byRoute[route] || 0) + 1;
        results.push({ route, rows });
      }
      if (!results.length) return null;
      const rows = dedupe(results.flatMap((entry) => entry.rows));
      const counts = Object.fromEntries(results.map((entry) => [entry.route, entry.rows.length]));
      const sample = { rows, capturedAt: at, counts, received: results.reduce((sum, entry) => sum + entry.rows.length, 0) };
      this.#samples.set(chain, sample);
      // A route that did not answer is reported, because a radar that quietly
      // lost one of its two routes still looks like a radar.
      this.lastDiscoveryHealth = { provider: RADAR_PROVIDER, complete: failed === 0, checkedAt: at,
        received: sample.received, counts, failedRoutes: failed };
      return sample;
    })().finally(() => { if (this.#inflight.get(chain) === job) this.#inflight.delete(chain); });
    this.#inflight.set(chain, job);
    return job;
  }

  #fresh(chain) {
    const sample = this.#samples.get(chain);
    if (!sample) return false;
    return this.now() - sample.capturedAt < this.refreshMs;
  }

  // The scanner's discovery read. Returns what the routes gave us, or an empty
  // list plus a health record that says the read failed - never a half-sample
  // presented as a complete one.
  async discover(chain, { signal } = {}) {
    if (signal?.aborted) return [];
    if (!this.chains.includes(chain)) return [];
    if (!await this.configured()) {
      this.lastDiscoveryHealth = { provider: RADAR_PROVIDER, complete: false, checkedAt: this.now(),
        code: 'GMGN_DISABLED', message: 'GMGN 只读接口未配置或正在冷却' };
      return [];
    }
    const sample = await this.#refresh(chain);
    if (!sample) {
      // Keep the previous sample rather than emptying the radar: a failed read
      // is not evidence that the market emptied.
      const stale = this.#samples.get(chain);
      if (!stale) {
        this.lastDiscoveryHealth = { provider: RADAR_PROVIDER, complete: false, checkedAt: this.now(),
          code: this.client.snapshot?.().lastErrorCode || 'GMGN_READ_FAILED', message: 'GMGN 发现读取未成功' };
        return [];
      }
      this.metrics.cacheHits++;
      return stale.rows.map((row) => ({ ...row, stale: true }));
    }
    return sample.rows;
  }

  // The radar's read. `refresh: false` is the passive path the page polls: it
  // never pays for a read while the sample is still fresh, and when the sample
  // has aged past the refresh clock it takes one. A passive read that waited
  // for the previous one to be rebuilt is how a UI ends up blocking on a
  // provider.
  async live(chain, { refresh = true } = {}) {
    if (!this.chains.includes(chain)) return { tokens: [], capturedAt: null };
    const cached = this.#samples.get(chain);
    if (refresh === false) {
      if (this.#fresh(chain)) { this.metrics.cacheHits++; return { tokens: cached.rows, capturedAt: cached.capturedAt }; }
      if (await this.configured()) await this.#refresh(chain);
      const sample = this.#samples.get(chain);
      return sample ? { tokens: sample.rows, capturedAt: sample.capturedAt } : { tokens: [], capturedAt: null };
    }
    const sample = await this.#refresh(chain);
    const resolved = sample || cached;
    return resolved ? { tokens: resolved.rows, capturedAt: resolved.capturedAt } : { tokens: [], capturedAt: null };
  }

  // Delegated so the outcome read-back can price a GMGN baseline with GMGN's
  // own candles. One ruler per curve.
  async priceAt(address, targetAt, chain, options) {
    if (typeof this.client.priceAt !== 'function') return null;
    return this.client.priceAt(address, targetAt, chain, options);
  }

  // The old provider had credentials a user could rotate from the page; this
  // one does not. Kept as a no-op so shutdown and any remaining caller stay
  // honest about what they are asking for rather than crashing on a missing
  // method.
  resetCredentials() { this.lastDiscoveryHealth = null; }
}

export function createGmgnRadar(options = {}) {
  const apiKey = options.apiKey ?? loadApiKey();
  if (!apiKey && !options.client) return null;
  return new GmgnRadarSource({ ...options, apiKey });
}
