// A direct HTTP client for GMGN's OpenAPI.
//
// Why this talks to the API instead of shelling out to gmgn-cli:
//   1. gmgn-cli pays a ~3.7 s node process spawn per call. The trenches feed is a
//      fixed 60-item newest-first window (the CLI's --limit is ignored server
//      side) covering only ~100-140 s of Solana creations, so the poll cadence
//      that avoids gaps is itself around 100 s. Spending 3.7 s of a 100 s budget
//      on process startup is waste, and it makes precise pacing impossible.
//   2. Market routes use "exist" auth: an X-APIKEY header plus `timestamp` and
//      `client_id` query params. No private-key signature is involved - that is
//      only for swap/order routes - so Node's built-in fetch and
//      crypto.randomUUID are sufficient. The project keeps its zero
//      runtime-dependency rule.
//   3. This module deliberately never reads GMGN_PRIVATE_KEY. A read-only radar
//      has no business holding a signing key; only the API key is loaded.
//
// Measured behaviour it is built around (see .workbuddy/GMGN数据源评估.md):
//   - Envelope is { code, data, message, error }; success is code === 0.
//   - Throttling escalates to an IP ban: RATE_LIMIT_BANNED, starting at 5 s and
//     extendable to 5 minutes, so pacing and backoff are correctness features
//     rather than politeness. The reset moment arrives either in the
//     `x-ratelimit-reset` header (Unix seconds) or as `reset_at` in the body.
//   - Client-side bucket is the documented one: rate 20/s, capacity 20, and each
//     route costs its own weight (trenches 3, trending 1, signal 3).
//   - Limit is ignored server-side: trenches always answers 60 rows per category.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = 'https://openapi.gmgn.ai';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const RATE_LIMIT_CODES = new Set(['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_BANNED']);
// Upper bound on how long a single request will queue behind the client's own
// pacing before the client gives up and reports PACING_OVERFLOW.
const PACING_BUDGET_MS = 30_000;

export const GMGN_ROUTES = Object.freeze({
  trenches: Object.freeze({ method: 'POST', path: '/v1/trenches', weight: 3 }),
  trending: Object.freeze({ method: 'GET', path: '/v1/market/rank', weight: 1 }),
  signal: Object.freeze({ method: 'POST', path: '/v1/market/token_signal', weight: 3 }),
  // Measured (gmgn-surface-probe, 2026-10-04): 4/4 tracked feed rows returned a
  // live price, ~230ms, and the liquidity it reports matched the trenches row
  // for the same pool to within 0.98-1.00 - the same ruler, so the two readings
  // may share a record. Weight 1, which makes a per-pool price fill affordable.
  tokenInfo: Object.freeze({ method: 'GET', path: '/v1/token/info', weight: 1 }),
  // The highest-value alpha this provider exposes, and the cheapest: the
  // trenches feed is a firehose where >99% of rows are junk, while these two
  // return what wallets with a *measured* track record are trading right now.
  // Both are weight 1 and both use exist-auth (API key only, no signature),
  // so a cluster of smart-money buys is affordable to poll continuously.
  smartmoney: Object.freeze({ method: 'GET', path: '/v1/user/smartmoney', weight: 1 }),
  kol: Object.freeze({ method: 'GET', path: '/v1/user/kol', weight: 1 }),
  // The only route that answers "what did this token cost at moment X". Without
  // it the outcome sampler (src/outcomes.mjs) short-circuits on
  // `typeof provider.priceAt !== 'function'` and no result is ever measured, so
  // this radar can never be falsified. Weight 2, so a read-back cycle is cheap
  // but not free - it still shares the one IP bucket with discovery.
  kline: Object.freeze({ method: 'GET', path: '/v1/market/token_kline', weight: 2 })
});

// Read-back window for priceAt. A 1-minute candle at targetAt can only exist if
// the window spans it; three minutes each way absorbs a candle published a
// little late without pulling in so much that the nearest-match test becomes
// meaningless.
export const KLINE_WINDOW_MS = 3 * 60_000;
// A candle further from the target than this is not an answer to the question
// that was asked. Matches the tolerance src/outcomes.mjs already applies to the
// sample it accepts.
export const KLINE_MATCH_MS = 60_000;
// 🚨 `time` is the candle's OPEN moment, not the moment its close is true.
// Measured (probe-kline-openclose, 2026-10-04, SOL LEVERAGED): the newest row
// always sits exactly at floor(now/60000)*60000, and the same row's close was
// still moving 70 s later (0.000026365369 -> 0.000025904357, volume
// 1859 -> 4550) while every older row was byte-identical - i.e. the newest row
// is the in-progress candle. The close printed on it only becomes true one
// resolution later.
//
// This is not cosmetic. src/outcomes.mjs rejects any sample whose
// |at - targetAt| exceeds 60 s; reporting the open would date a price 60 s
// early and, for a target landing late in a minute, push the nearest candle
// past the tolerance so the sample is thrown away as "no candle" - a silent
// zero dressed up as an absent market.
export const KLINE_CLOSE_OFFSET_MS = 60_000;
export const KLINE_RESOLUTION = '1m';

export const TRACK_KINDS = Object.freeze(['smartmoney', 'kol']);

// A sell priced in the chain's native token reports the *native* mint as
// base_address, so the feed contains rows like "sold WSOL" that look like a
// token trade and mean nothing. Measured on the live feed: the native mint
// shows up within the first three rows. These are never mint subjects.
export const NATIVE_MINTS = Object.freeze({
  sol: Object.freeze(['So11111111111111111111111111111111111111112']),
  bsc: Object.freeze(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'])
});

export const TRENCHES_TYPES = Object.freeze(['new_creation', 'near_completion', 'completed']);

// These two maps mirror the allow-list the CLI sends. They are data, not policy:
// an empty array filters every result out, so an unknown chain must omit the
// field entirely and let the API apply its own default rather than send [].
export const TRENCHES_PLATFORMS = Object.freeze({
  sol: Object.freeze([
    'Pump.fun', 'pump_mayhem', 'pump_mayhem_agent', 'pump_agent',
    'letsbonk', 'bonkers', 'bags', 'memoo', 'liquid', 'bankr', 'zora',
    'surge', 'anoncoin', 'moonshot_app', 'wendotdev', 'heaven', 'sugar',
    'token_mill', 'believe', 'trendsfun', 'trends_fun', 'jup_studio',
    'Moonshot', 'boop', 'ray_launchpad', 'meteora_virtual_curve', 'xstocks'
  ]),
  bsc: Object.freeze([
    'fourmeme', 'fourmeme_agent', 'bn_fourmeme', 'four_xmode_agent',
    'cubepeg', 'likwid', 'goplus_creator', 'goplus_skills', 'openfour',
    'flap', 'flap_stocks', 'flap_aioracle', 'clanker', 'lunafun'
  ])
});

export const TRENCHES_QUOTE_ADDRESS_TYPES = Object.freeze({
  sol: Object.freeze([4, 5, 3, 1, 13, 0]),
  bsc: Object.freeze([6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0])
});

// The API's duration filters are typed `string` on the wire, not numbers. Sending
// a number is rejected outright with `filter_invalid`, which arrives as HTTP 200
// with `code: -1` and an empty payload for every category - i.e. it looks exactly
// like "the source has no data", which is the one failure mode this project
// cannot afford to misread. So the coercion lives here, in the request builder,
// where no caller can forget it.
//
// This project counts token ages in seconds everywhere (config.minAgeSec), so a
// bare number means seconds. The gmgn-cli accepts a bare number as *minutes*;
// that disagreement is precisely the silent off-by-60 this function removes.
export const DURATION_FILTERS = Object.freeze(new Set(['min_created', 'max_created']));

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([smhd])?$/;

export function gmgnDuration(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`invalid duration: ${value}`);
    return `${value}s`;
  }
  const match = String(value ?? '').trim().match(DURATION_PATTERN);
  if (!match) throw new TypeError(`invalid duration: ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new TypeError(`invalid duration: ${JSON.stringify(value)}`);
  switch (match[2] ?? 's') {
    case 's': return `${amount}s`;
    case 'm': return `${amount}m`;
    // The API documents m/h/d, but only s and m are known to survive the raw
    // upstream path; converting is safer than sending a unit it may reject.
    case 'h': return `${amount * 60}m`;
    default: return `${amount * 1440}m`;
  }
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// Rates arrive as 0..1 numbers, but 0 is a real reading, so it must survive.
const rate = (value) => {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
};

// Several safety fields arrive as the strings "1"/"0" rather than booleans.
const flag = (value) => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
};

const text = (value, max = 120) => {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : null;
};

// GMGN nests a token's identity as `<address>-<chain>` in some payloads and as a
// bare address in others; both forms appear in the wild.
export function gmgnBareAddress(chain, value) {
  const suffix = chain === 'sol' ? '-solana' : '-' + chain;
  const raw = String(value ?? '').trim();
  return raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
}

// Read the API key without ever touching the signing key. Env wins so a caller
// can override; otherwise fall back to the file the CLI itself uses.
export function loadApiKey({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  const fromEnv = String(env.GMGN_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(home, '.config', 'gmgn', '.env');
    for (const line of String(readFile(file, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?GMGN_API_KEY\s*=\s*(.*)$/);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  } catch { /* A missing file simply means the provider stays disabled. */ }
  return '';
}

// The CLI sends filters flat inside each category section, alongside the
// allow-lists. Kept as a pure builder so the exact request is unit-testable.
// Throws on a malformed duration: a gate that cannot be expressed must stop the
// request rather than be dropped, because dropping it silently widens discovery.
export function buildTrenchesBody({ chain, types = TRENCHES_TYPES, filters = {}, platforms = null, limit = 80 } = {}) {
  const selected = Array.isArray(types) && types.length ? types : TRENCHES_TYPES;
  const allow = Array.isArray(platforms) && platforms.length ? platforms : (TRENCHES_PLATFORMS[chain] ?? []);
  const quoteTypes = TRENCHES_QUOTE_ADDRESS_TYPES[chain] ?? [];
  const shaped = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    shaped[key] = DURATION_FILTERS.has(key) ? gmgnDuration(value) : value;
  }
  const body = { version: 'v2' };
  for (const type of selected) {
    const section = {
      filters: ['offchain', 'onchain'],
      launchpad_platform_v2: true,
      limit: Math.min(80, Math.max(1, Number(limit) || 80)),
      ...shaped
    };
    if (allow.length) section.launchpad_platform = [...allow];
    if (quoteTypes.length) section.quote_address_type = [...quoteTypes];
    body[type] = section;
  }
  return body;
}

// The CLI prints `data`, which is sometimes itself another envelope; peel until
// a non-envelope object remains. A missing `code` means we are already inside.
export function unwrap(payload) {
  let node = payload;
  for (let depth = 0; depth < 3; depth++) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    if (node.code === undefined || node.data === undefined) return node;
    node = node.data;
  }
  return node;
}

// One trenches row -> the neutral shape this project reasons about. Everything
// that is missing stays null: a provider that does not answer a question must
// never be allowed to imply an answer.
export function normalizeTrenchesRow(row, chain, at) {
  if (!row || typeof row !== 'object') return null;
  const address = gmgnBareAddress(chain, row.address);
  if (!address) return null;
  return {
    provider: 'GMGN',
    chain,
    address,
    symbol: text(row.symbol, 30),
    name: text(row.name ?? row.trans_symbol_zhcn, 80),
    price: num(row.price),
    // market_cap / liquidity here are the pool-scoped figures the calibration run
    // confirmed match DexScreener to ~0.1%, unlike AVE's inflated pool TVL.
    marketCap: num(row.market_cap ?? row.usd_market_cap),
    liquidity: num(row.liquidity),
    holders: num(row.holder_count),
    volume24h: num(row.volume_24h),
    swaps24h: num(row.swaps_24h),
    buys24h: num(row.buys_24h),
    sells24h: num(row.sells_24h),
    netBuy24h: num(row.net_buy_24h),
    top10Rate: rate(row.top_10_holder_rate),
    devHoldRate: rate(row.dev_team_hold_rate),
    sniperHoldRate: rate(row.top70_sniper_hold_rate),
    insiderHoldRate: rate(row.suspected_insider_hold_rate),
    freshWalletRate: rate(row.fresh_wallet_rate),
    privateVaultRate: rate(row.private_vault_hold_rate),
    creatorHoldRate: rate(row.creator_balance_rate),
    // These four are exactly what discoveryScreen's non-AVE branch wants and what
    // AVE reports as a hard null. is_honeypot is not in this payload; it lives on
    // the per-token security route and is fetched only when a lead warrants it.
    rugRatio: rate(row.rug_ratio),
    washTrading: flag(row.is_wash_trading),
    ratTraderRate: rate(row.rat_trader_amount_rate),
    bundlerRate: rate(row.bundler_trader_amount_rate),
    entrapmentRate: rate(row.entrapment_ratio),
    botDegenRate: rate(row.bot_degen_rate),
    smartMoneyCount: num(row.smart_degen_count),
    renownedCount: num(row.renowned_count),
    botDegenCount: num(row.bot_degen_count),
    renouncedMint: flag(row.renounced_mint),
    renouncedFreeze: flag(row.renounced_freeze_account),
    burnStatus: text(row.burn_status, 24),
    buyTax: rate(row.buy_tax),
    sellTax: rate(row.sell_tax),
    createdAt: num(row.created_timestamp) ?? num(row.open_timestamp),
    openAt: num(row.open_timestamp),
    progress: rate(row.progress),
    launchpad: text(row.launchpad, 40),
    launchpadStatus: num(row.launchpad_status),
    poolAddress: text(row.pool_address, 80),
    exchange: text(row.exchange, 60),
    creatorCreatedCount: num(row.creator_created_count),
    creatorTokenStatus: text(row.creator_token_status, 40),
    twitter: text(row.twitter, 120),
    website: text(row.website, 200),
    telegram: text(row.telegram, 120),
    observedAt: at
  };
}

// One token-info payload -> the market readings this project folds into a
// tracked record. Measured field names on the live route: the price lives at
// `price.price` as a string (the siblings price_1m..price_24h are the window
// opens), liquidity is a string, holder_count a number - so every numeric is
// coerced once here rather than trusted at the call site. The market cap is
// deliberately NOT recomputed here from price x supply: the trenches row the
// record already carries has its own market_cap reading, and two derivations
// of one number is exactly how a mixed ruler gets in.
export function normalizeTokenInfo(data) {
  if (!data || typeof data !== 'object') return null;
  const price = num(data.price?.price);
  return {
    provider: 'GMGN',
    price: price !== null && price > 0 ? price : null,
    liquidity: num(data.liquidity),
    holders: num(data.holder_count),
    volume1h: num(data.price?.volume_1h),
    smartWallets: num(data.wallet_tags_stat?.smart_wallets),
    renownedWallets: num(data.wallet_tags_stat?.renowned_wallets)
  };
}

// One wallet-trade row -> the neutral shape this project reasons about.
//
// The convention worth getting right: on the kol/smartmoney routes
// `is_open_or_close` is 0 for opened/added and 1 for closed/reduced, which is
// the *opposite* of the follow-wallet route. Only these two routes are read
// here, so the field is exposed as `isClose` and never as "is open".
export function normalizeTrackRow(row, chain, kind) {
  if (!row || typeof row !== 'object') return null;
  const address = gmgnBareAddress(chain, row.base_address);
  const maker = String(row.maker ?? '').trim();
  if (!address || !maker) return null;
  const flagValue = num(row.is_open_or_close);
  const side = row.side === 'sell' ? 'sell' : row.side === 'buy' ? 'buy' : null;
  return {
    provider: 'GMGN',
    kind,
    chain,
    // base_address is the token being traded; quote_address (SOL) is only what
    // it was priced in and must never be mistaken for the subject.
    address,
    maker,
    side,
    // Missing stays null: an unanswered direction question is not "hold".
    isClose: flagValue === null ? null : flagValue === 1,
    amountUsd: num(row.amount_usd),
    priceUsd: num(row.price_usd),
    buyCostUsd: num(row.buy_cost_usd),
    tokenAmount: num(row.token_amount),
    at: num(row.timestamp),
    symbol: text(row.base_token?.symbol, 30),
    launchpad: text(row.base_token?.launchpad, 40),
    twitter: text(row.maker_info?.twitter_username, 60),
    tags: Array.isArray(row.maker_info?.tags) ? row.maker_info.tags.map((tag) => text(tag, 24)).filter(Boolean) : []
  };
}

// Convergence detection: several distinct wallets buying the same token inside
// a short window is a stronger statement than any single trade, and it is the
// one signal a firehose cannot produce. Counted per (token, side) over distinct
// makers so one wallet trading twice never reads as two wallets.
export const CLUSTER_WINDOW_MS = 30 * 60_000;

export function clusterTrades(rows, { windowMs = CLUSTER_WINDOW_MS, now = Date.now() } = {}) {
  // `at` arrives as Unix *seconds* while `now` is milliseconds. Comparing them
  // directly fails the window test for every row, which looks exactly like "no
  // convergence out there" - so the conversion is done once, here.
  const fresh = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || !row.address || !row.maker || !row.side) continue;
    const seconds = num(row.at);
    if (seconds === null) continue;
    const atMs = seconds * 1000;
    if (atMs > now || now - atMs > windowMs) continue;
    fresh.push({ row, atMs });
  }
  const groups = new Map();
  for (const { row, atMs } of fresh) {
    const key = `${row.chain}:${row.address}:${row.side}`;
    const group = groups.get(key) || { chain: row.chain, address: row.address, side: row.side, symbol: row.symbol || '',
      makers: new Map(), amountUsd: 0, kinds: new Set(), closes: 0, firstAtMs: atMs, lastAtMs: atMs };
    group.makers.set(row.maker, (group.makers.get(row.maker) || 0) + 1);
    group.amountUsd += row.amountUsd ?? 0;
    group.kinds.add(row.kind);
    if (row.isClose === true) group.closes++;
    group.firstAtMs = Math.min(group.firstAtMs, atMs);
    group.lastAtMs = Math.max(group.lastAtMs, atMs);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const wallets = group.makers.size;
    const hasKol = group.kinds.has('kol');
    const hasSmart = group.kinds.has('smartmoney');
    // The published strength scale. A cluster of full exits is deliberately not
    // promoted to the top rung: three wallets selling is a warning, not a buy.
    const strength = hasSmart && wallets >= 3 ? (hasKol && group.closes === 0 ? 'VERY_STRONG' : 'STRONG')
      : hasSmart && wallets >= 2 ? 'MEDIUM' : 'WEAK';
    return {
      chain: group.chain, address: group.address, side: group.side, symbol: group.symbol,
      wallets, amountUsd: group.amountUsd, closes: group.closes,
      smartMoney: hasSmart, kol: hasKol,
      // Reported in the same unit the API uses, so callers never mix the two.
      firstAt: Math.floor(group.firstAtMs / 1000), lastAt: Math.floor(group.lastAtMs / 1000),
      makers: [...group.makers.keys()],
      strength
    };
  }).sort((a, b) => b.wallets - a.wallets || b.amountUsd - a.amountUsd);
}

export class GmgnClient {
  constructor({
    apiKey = '',
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    host = HOST,
    timeoutMs = 15_000,
    maxResponseBytes = DEFAULT_MAX_BYTES,
    // Documented leaky bucket. Kept as a client-side guard so we never rely on
    // the server to police us into a ban.
    ratePerSecond = 20,
    capacity = 20,
    // A defensive floor on top of the bucket: the ban we actually observed came
    // with no prior 429s we could attribute, so spacing is treated as insurance.
    minGapMs = 1_200,
    banStrikesBeforeLongCooldown = 2,
    strikeCooldownMs = 5 * 60_000
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.host = String(host).replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 15_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.ratePerSecond = Math.max(1, Number(ratePerSecond) || 20);
    this.capacity = Math.max(1, Number(capacity) || 20);
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.banStrikesBeforeLongCooldown = Math.max(1, Number(banStrikesBeforeLongCooldown) || 2);
    this.strikeCooldownMs = Math.max(1_000, Number(strikeCooldownMs) || 5 * 60_000);
    this.tokens = this.capacity;
    this.bucketAt = this.now();
    this.lastRequestAt = 0;
    this.retryAt = 0;
    this.strikes = 0;
    this.health = { requests: 0, ok: 0, failed: 0, throttled: 0, banned: 0, lastErrorCode: '', lastErrorDetail: '', lastRequestAt: 0, lastOkAt: 0 };
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  cooling() {
    return this.retryAt > this.now();
  }

  snapshot() {
    const at = this.now();
    return {
      ...this.health,
      enabled: this.enabled,
      retryAt: this.retryAt,
      cooling: this.retryAt > at,
      strikes: this.strikes,
      tokens: Number(this.tokens.toFixed(2)),
      capacity: this.capacity,
      nextAllowedAt: Math.max(this.retryAt, this.lastRequestAt + this.minGapMs)
    };
  }

  // Refill lazily on read so the bucket never drifts while idle.
  #refill(at) {
    const elapsed = Math.max(0, at - this.bucketAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerSecond) / 1000);
    this.bucketAt = at;
  }

  async #awaitSlot(cost) {
    // The pause is computed from the injected clock, so the budget has to be on
    // the *total* time spent waiting rather than on a single pause: a clock that
    // does not advance (a frozen clock under test, or a system clock that steps
    // backwards) would recompute an identical wait forever, and a per-pause
    // ceiling would never trip.
    let waited = 0;
    for (;;) {
      const at = this.now();
      this.#refill(at);
      const gapLeft = this.lastRequestAt + this.minGapMs - at;
      if (this.tokens >= cost && gapLeft <= 0) {
        this.tokens -= cost;
        return true;
      }
      const needTokens = this.tokens >= cost ? 0 : ((cost - this.tokens) / this.ratePerSecond) * 1000;
      const pause = Math.max(50, gapLeft, needTokens);
      if (waited + pause > PACING_BUDGET_MS) return false;
      waited += pause;
      await this.sleep(pause);
    }
  }

  // Reads `reset_at` from the body or `x-ratelimit-reset` from the headers, both
  // Unix seconds. Returns 0 when the server declined to say when it clears.
  #resetAt(response, payload) {
    const fromBody = num(payload?.reset_at);
    if (fromBody && fromBody > 0) return fromBody * 1000;
    const header = response?.headers?.get?.('x-ratelimit-reset');
    const parsed = Number.parseInt(header ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 0;
  }

  // Never throws. Returns the unwrapped `data` or null, with the reason recorded
  // in health so a silent null can always be explained after the fact.
  async request(routeName, { query = {}, body = null } = {}) {
    const route = GMGN_ROUTES[routeName];
    if (!route) return null;
    if (!this.enabled) {
      this.health.lastErrorCode = 'NO_API_KEY';
      return null;
    }
    const at = this.now();
    if (this.retryAt > at) {
      this.health.lastErrorCode = 'COOLING';
      return null;
    }

    const granted = await this.#awaitSlot(route.weight);
    if (!granted) {
      this.health.lastErrorCode = 'PACING_OVERFLOW';
      return null;
    }

    const url = new URL(this.host + route.path);
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('timestamp', String(Math.floor(this.now() / 1000)));
    url.searchParams.set('client_id', crypto.randomUUID());

    this.lastRequestAt = this.now();
    this.health.requests++;
    this.health.lastRequestAt = this.lastRequestAt;

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: route.method,
        headers: {
          'X-APIKEY': this.apiKey,
          accept: 'application/json',
          ...(body === null ? {} : { 'content-type': 'application/json' })
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      this.health.failed++;
      this.health.lastErrorCode = String(error?.name || error?.code || 'FETCH_FAILED');
      return null;
    }

    let payload = null;
    try {
      const raw = await response.text();
      if (raw.length > this.maxResponseBytes) {
        this.health.failed++;
        this.health.lastErrorCode = 'RESPONSE_TOO_LARGE';
        return null;
      }
      payload = JSON.parse(raw);
    } catch {
      this.health.failed++;
      this.health.lastErrorCode = 'INVALID_JSON';
      return null;
    }

    if (payload?.code !== 0) {
      const apiError = String(payload?.error || '');
      const resetAt = this.#resetAt(response, payload);
      if (RATE_LIMIT_CODES.has(apiError) || response.status === 429) {
        this.strikes++;
        if (apiError === 'RATE_LIMIT_BANNED') this.health.banned++;
        else this.health.throttled++;
        const backoff = this.strikes >= this.banStrikesBeforeLongCooldown
          ? Math.max(resetAt - this.now(), this.strikeCooldownMs)
          : Math.max(resetAt - this.now(), 5_000);
        // A little headroom past the server's own deadline; retrying exactly on
        // the boundary has been observed to extend the ban.
        this.retryAt = this.now() + Math.min(backoff + 1_000, this.strikeCooldownMs);
        this.health.lastErrorCode = apiError || 'HTTP_429';
        return null;
      }
      this.health.failed++;
      this.health.lastErrorCode = apiError || String(payload?.code ?? 'API_ERROR');
      return null;
    }

    this.strikes = 0;
    this.health.ok++;
    this.health.lastOkAt = this.now();
    this.health.lastErrorCode = '';
    this.health.lastErrorDetail = '';
    return unwrap(payload);
  }

  // Newly created / nearly complete / graduated launchpad tokens. The server
  // applies the filters, so this is a discovery query, not a raw firehose.
  async trenches(chain, { types = TRENCHES_TYPES, filters = {}, platforms = null, limit = 80 } = {}) {
    // A malformed gate is a programming error, but this client's contract is that
    // it never throws, so it is converted into an explained null: fail closed,
    // spend nothing, and leave a reason in health.
    let body;
    try {
      body = buildTrenchesBody({ chain, types, filters, platforms, limit });
    } catch (error) {
      this.health.failed++;
      this.health.lastErrorCode = 'FILTER_INVALID';
      this.health.lastErrorDetail = String(error?.message || error);
      return null;
    }
    const data = await this.request('trenches', { query: { chain }, body });
    if (!data || typeof data !== 'object') return null;
    const at = this.now();
    const rows = [];
    for (const type of Object.keys(body)) {
      const bucket = data[type];
      if (!Array.isArray(bucket)) continue;
      for (const row of bucket) {
        const normalized = normalizeTrenchesRow(row, chain, at);
        if (normalized) rows.push({ ...normalized, bucket: type });
      }
    }
    // The feed repeats the same token across categories as it progresses, so a
    // caller that concatenates must dedupe by address.
    const unique = new Map();
    for (const row of rows) if (!unique.has(row.address)) unique.set(row.address, row);
    return [...unique.values()];
  }

  // One token's current market reading. The discovery feed (trenches) carries
  // no price at all - measured across 1279 live rows - so this is the route
  // that gives a tracked lead its price axis, from the same provider the lead
  // came from rather than a second source with its own ruler.
  async tokenInfo(chain, address) {
    const data = await this.request('tokenInfo', { query: { chain, address } });
    if (!data || typeof data !== 'object') return null;
    return normalizeTokenInfo(data);
  }

  // One token's price at one moment in the past, read back through the kline
  // route - the question the outcome sampler asks so this radar can be proved
  // wrong. Deliberately the same contract as AveClient.priceAt:
  // `{ at, price, source, capturedAt }` or null, so src/outcomes.mjs cannot tell
  // the two providers apart and needs no per-provider branch.
  //
  // 🚨 `from`/`to` are MILLISECONDS. The gmgn-cli converts seconds for you; this
  // client speaks HTTP directly, so nothing converts. Measured
  // (probe-kline-ms, 2026-10-04, SOL LIFE): the same address over the same
  // window answered 6 candles in milliseconds and 0 candles in seconds, both as
  // HTTP 200 with code 0 - a wrong unit is indistinguishable from "no trades
  // happened", which is exactly the silence this project refuses to emit.
  //
  // Returns null rather than a zero or a guess whenever the answer is missing:
  // no candle in the window, a candle too far from the target, or a close that
  // is not a positive number. A read-back that is still being written (the
  // in-progress minute) also reads as null - it is not an answer yet.
  async priceAt(ca, targetAt, chain = 'bsc', options = {}) {
    const address = String(ca ?? '').trim();
    if (!address || !Number.isFinite(targetAt) || targetAt <= 0) return null;
    const now = this.now();
    // The future has no candle; asking for it would only spend quota.
    if (targetAt > now) return null;
    const data = await this.request('kline', {
      query: {
        chain,
        address,
        resolution: KLINE_RESOLUTION,
        from: targetAt - KLINE_WINDOW_MS,
        to: Math.min(now, targetAt + KLINE_WINDOW_MS)
      }
    });
    const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : null;
    if (!list || !list.length) return null;
    let best = null;
    for (const row of list) {
      const openedAt = num(row?.time);
      if (openedAt === null || openedAt <= 0) continue;
      const price = num(row?.close);
      // A zero or negative close is a real reading on this route for dead
      // pools, and folding it into a return would fabricate a -100% outcome.
      if (price === null || !(price > 0)) continue;
      const at = openedAt + KLINE_CLOSE_OFFSET_MS;
      // An unfinished candle is not an answer; it is still moving.
      if (at > now) continue;
      const distance = Math.abs(at - targetAt);
      if (distance > KLINE_MATCH_MS) continue;
      if (!best || distance < best.distance) best = { distance, at, price };
    }
    if (!best) return null;
    return { at: best.at, price: best.price, source: 'GMGN_1M_CLOSE', capturedAt: this.now() };
  }

  // Real-time trades from wallets GMGN has tagged smart money or KOL. `side` is
  // filtered here rather than server-side because the route accepts it as a
  // query param only in the CLI's client-side implementation.
  async trackTrades(kind, chain, { limit = 100, side = null } = {}) {
    if (!TRACK_KINDS.includes(kind)) return null;
    const size = Math.min(200, Math.max(1, Number(limit) || 100));
    const data = await this.request(kind, { query: { chain, limit: size } });
    const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : null;
    if (!list) return null;
    const rows = [];
    const natives = new Set((NATIVE_MINTS[chain] ?? []).map(value => value.toLowerCase()));
    for (const row of list) {
      const normalized = normalizeTrackRow(row, chain, kind);
      // The wrapped-native row is a pricing leg, not a token being traded.
      if (!normalized || natives.has(normalized.address.toLowerCase())) continue;
      if (side && normalized.side !== side) continue;
      rows.push(normalized);
    }
    return rows;
  }
}

export { HOST as GMGN_HOST };
