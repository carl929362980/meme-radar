import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export const config = Object.freeze({
  chain: 'bsc',
  // This build is deliberately scoped to the two chains it is actually run
  // against. Advertising a chain here is a promise that discovery and
  // secondary safety both work on it; listing anything unmaintained makes an
  // empty tab look like a healthy chain.
  supportedChains: Object.freeze(['sol', 'bsc']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, 300_000, 30_000, 30 * 60_000),
  // The public fast-feed build performs one hot-list request per turn. Deep
  // token reads are opt-in because a second endpoint can have a stricter
  // provider rate bucket and must never stall the primary discovery lane.
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, 0, 0, 12),
  auditCycleBudgetMs: 80_000,
  // Read-backs per scan. Zero leaves the outcome table empty forever: a named
  // baseline is only ever completed by the provider that priced it, and the
  // passive path can only complete a row from a live quote of that same
  // provider - so a GMGN baseline with no read-back is never measured at all.
  //
  // Two is deliberately tiny, and it is a ceiling rather than a target: one
  // read is weight 2 on a budget where a single discovery poll costs about ten,
  // so a backlog is worked a couple of rows per scan and measurement can never
  // crowd out discovery.
  outcomeReadsPerCycle: boundedInteger(process.env.RADAR_OUTCOME_READS_PER_CYCLE, 2, 0, 12),
  xReviewMode: 'manual',
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 150_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  strictLiquidity: 8_000,
  // Fast alerts should favor current activity. These are dynamic opportunity
  // gates, not permanent contract-risk exclusions.
  matureMarketAgeSec: 60 * 60,
  oldMarketAgeSec: 6 * 60 * 60,
  minMatureVolume5mUsd: 100,
  minOldVolume5mUsd: 250,
  minMatureTurnover5m: 0.005,
  minOldTurnover5m: 0.01,
  maxCollapsedAthRatio: 0.10,
  strongRebound1h: 0.20,
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  // A passing lead remains visible across a complete multi-chain/page rotation.
  // Its quote clocks are not extended; this is display retention only.
  liveLeadRetentionMs: 30 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
  // Tracking is a first-sighting comparison, so it is kept on its own retention
  // clock instead of the outcome windows that calibration depends on.
  trackRetentionMs: 7 * 24 * 60 * 60_000,
  // Feed leads age on the feed's own clock, not the market board's.
  //
  // Raised from one hour to twenty-four, because one hour is shorter than the
  // machine's own measurement horizon: the outcome table reads a baseline back
  // at T+5m through T+24h, and a card that only crosses its first rung after an
  // hour of watching was being deleted before it could ever be entered into the
  // frame. The whole point of the table is to answer "did this find anything",
  // and a frame that only ever holds cards which happened to move in their
  // first hour cannot answer it.
  //
  // The old one-hour bound was justified by a projection - tens of thousands of
  // records a day per chain, a state file in the hundreds of megabytes - that
  // belongs to the market board's *week*, not to a day. Measured on the live
  // set (2026-10-04): 40 records alive under a one-hour bound, ~950 bytes each
  // on the wire, i.e. roughly 1 MB per chain per day at twenty-four hours.
  //
  // This clock is also not the one that retires most feed leads - silence is
  // (see `trackStaleMs`), and it is still the shorter of the two for a pool the
  // feed has stopped reporting. Raising this ceiling therefore widens which
  // leads *can* be measured without filling the board with every pool ever
  // seen; the cards that stop being news are what the board's collapsed
  // section exists to hold.
  feedTrackRetentionMs: 24 * 60 * 60_000,
  // The ceiling above is not what retires most leads — silence is. A lead the
  // market feed has stopped listing is over well before its week is up, and a
  // board that waits out the week shows a drained pool for six more days. The
  // default matches the measured churn of the hot list; see `STALE_LEAD_MS`.
  trackStaleMs: 2 * 60 * 60_000,
  trackSignalLimit: 40,
  trackCoolingMs: 30 * 60_000,
  // Holder concentration and a contract-safety verdict come from GoPlus, a
  // separate provider with its own ceiling. Measured: ~30 requests per rolling
  // minute, and the throttle arrives as HTTP 200 with body {code:4029}, not as
  // a 429. Reads are spent only on leads the board already follows, capped per
  // cycle so enrichment can never crowd out discovery, and cached so a ten
  // minute refresh is enough for a reading that moves this slowly.
  goplusLookupsPerCycle: boundedInteger(process.env.GOPLUS_LOOKUPS_PER_CYCLE, 8, 0, 40),
  goplusCacheMs: 10 * 60_000,
  goplusTimeoutMs: 12_000,
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public')
});
