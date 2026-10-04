// The signal layer: what turns a raw market feed into the two things this
// product actually promises - "a pool appeared" and "several proven wallets are
// moving together".
//
// Why it is a separate module rather than another branch inside live-discovery:
// that pipeline is AVE-shaped end to end (`marketProvider === 'AVE'`, an AVE
// snake_case raw row, an AVE budget). Dressing these rows in AVE's field names
// so they could ride the same pipeline would hide that the two sources do not
// agree on scale - the calibration run measured liquidity differing by up to
// 5x on the same pool - and the change-rate maths downstream would then compare
// two different rulers. So this channel is parallel and never merges.
//
// Nothing here is allowed to throw. A market feed is an unreliable dependency,
// and a radar that dies because a provider hiccupped is worse than one that
// reports "paused".
import { GmgnClient, clusterTrades, CLUSTER_WINDOW_MS, loadApiKey } from './gmgn.mjs';
import { assessLead } from './veto.mjs';
import { config } from './config.mjs';

export const SIGNAL_KINDS = Object.freeze(['NEW_POOL', 'ENTRY', 'EXIT']);

// The two chains need different buckets and different cadences, and both facts
// are measured rather than chosen:
//   SOL  new_creation is ordered newest-first and its whole window is ~100-140s
//        deep, so a 90s poll is the slowest cadence that still sees every pool.
//   BSC  new_creation never yields a tradeable pool. Even with a min_created
//        floor of 600s, all 60 rows still sat at ~4.2K market cap with zero
//        liquidity - they are "just minted" placeholders at any age. Measured
//        alternative: near_completion returns 59/60 above $500 liquidity. So BSC
//        gets a different bucket, not a differently-tuned copy of SOL's.
// The 25s trade cadence is set by coverage, not by budget: 100 rows spans only
// about 40-60s of activity, so anything slower than ~40s starts leaving holes.
// The $100 liquidity floor is a presence test, not a value judgement: below it
// there is no pool to observe at all. It is deliberately far under the AVE-era
// minLiquidity, because the earlier measurement showed a market-cap or
// value-scale gate removes almost exactly the population this product exists to
// see. No market-cap gate is applied anywhere.
export const CHAIN_PLANS = Object.freeze({
  sol: Object.freeze({
    poolMs: 90_000,
    tradeMs: 25_000,
    types: Object.freeze(['new_creation']),
    poolFilters: Object.freeze({ max_created: '30m', min_liquidity: 100, max_rug_ratio: 0.3, max_bundler_rate: 0.3, max_insider_ratio: 0.3 })
  }),
  bsc: Object.freeze({
    poolMs: 120_000,
    tradeMs: 25_000,
    types: Object.freeze(['near_completion']),
    // max_rug_ratio is deliberately absent: this chain's trenches response does
    // not carry rug_ratio at all, and the server treats a missing field as a
    // pass, so including it would advertise a gate that silently is not there.
    poolFilters: Object.freeze({ min_liquidity: 100, max_bundler_rate: 0.3, max_insider_ratio: 0.3 })
  })
});

const MAX_SIGNALS = 200;
const MAX_TRADES = 6_000;
const TICK_MS = 5_000;
// The trenches feed answers no price at all - measured across 1279 live rows -
// so a lead's price axis would stay dead forever and the two quadrant branches
// that read a price multiple would never fire for a feed lead. The token-info
// route (weight 1) fills that hole from the same provider, and its liquidity
// matched the trenches row for the same pool to within 0.98-1.00, which is the
// cross-check that makes one record legal (two sources on one ruler would
// publish the gap between them as a move). Affordability is a cadence, not a
// hope: a handful of reads per pool poll, newest leads first, never re-reading
// a pool more often than the gap below. At the 90-120 s pool cadence that is
// roughly three reads a minute - a rounding error against the 20/s bucket.
export const PRICE_ENRICH_PER_POLL = 6;
export const PRICE_ENRICH_GAP_MS = 4 * 60_000;
// The queue above it. Six reads per poll is a rounding error against the bucket
// but a rounding error against the arrival rate too: measured ~40 new pools a
// minute against 6 reads every ~90-120 s, so under the newest-first rule alone
// ~99% of pools never get a price at all - and a pool with no price cannot be
// entered into the outcome frame, which is how "the table is empty" survived
// every other fix.
//
// So the board may *ask* for a price. A card that reached the board without one
// is exactly the card that needs to be measured, and it needs precisely one
// read - not a place in a rotation. These are drained ahead of the rotation,
// capped per poll, and the queue itself is capped so a board that grows cannot
// grow the queue without bound.
export const PRICE_QUEUE_PER_POLL = 12;
export const PRICE_QUEUE_MAX = 400;
// A cluster may only re-announce itself when it has actually grown, or when this
// much time has passed. Without the second clause a cluster that stays at three
// wallets would fall silent, which is how a real accumulation gets missed.
const REFIRE_MS = 15 * 60_000;

// A radar is meant to run for weeks, so nothing it remembers may grow with the
// market. Pools and announcements are both retired on the clock that made them
// meaningful rather than on a count, because a count would either evict something
// still in use or keep something already dead.
//
// A pool can only anchor a cluster while the trade buffer still remembers the
// trades that formed it, so it is kept for the buffer's span (never less than
// half an hour, which is also the widest window the pools themselves are drawn
// from). An announcement only ever suppresses a re-announcement, and past
// `REFIRE_MS` the cooldown would have let it through anyway.
//
// Without this the pool map accumulates one entry per pool ever seen - measured
// at roughly 100k a day across the two chains - and every tracking fold, which
// runs every eight minutes, walks the whole map to hand the board the same
// expired leads over and over. The map is not capped by count because the honest
// bound is time: at 40 pools a minute the retention window settles at ~2k rows.
const POOL_RETENTION_MS = 30 * 60_000;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

// The risk facts a verdict is made from, pulled off the discovery row. Only the
// fields the checks actually read are carried, so a stored pool record cannot
// quietly accumulate provider payload it does not use.
//
// `devHoldRate` takes the worst of the two readings the provider offers: one is
// the team's wallet, the other the creator's, and a position hidden in either is
// still a position. Both are absent-tolerated - a chain that answers neither
// simply leaves the check unassessed.
export function vetoFacts(row) {
  const team = typeof row.devHoldRate === 'number' ? row.devHoldRate : null;
  const creator = typeof row.creatorHoldRate === 'number' ? row.creatorHoldRate : null;
  return {
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    creatorCreatedCount: row.creatorCreatedCount ?? null,
    creatorTokenStatus: row.creatorTokenStatus ?? null,
    liquidity: row.liquidity ?? null,
    bundlerRate: row.bundlerRate ?? null,
    ratTraderRate: row.ratTraderRate ?? null,
    insiderHoldRate: row.insiderHoldRate ?? null,
    sniperHoldRate: row.sniperHoldRate ?? null,
    devHoldRate: team === null && creator === null ? null : Math.max(team ?? 0, creator ?? 0),
    top10Rate: row.top10Rate ?? null,
    botDegenRate: row.botDegenRate ?? null,
    entrapmentRate: row.entrapmentRate ?? null,
    buyTax: row.buyTax ?? null,
    sellTax: row.sellTax ?? null,
    rugRatio: row.rugRatio ?? null,
    washTrading: typeof row.washTrading === 'boolean' ? row.washTrading : null,
    renouncedMint: typeof row.renouncedMint === 'boolean' ? row.renouncedMint : null
  };
}

// A refresh that omitted a field did not discover that the field is empty - it
// simply did not answer. Letting the null through would downgrade a previously
// assessed check to unassessed and, worse, read as "the risk went away". So a
// silent response keeps the last thing that was actually said.
function mergeFacts(previous, next) {
  const merged = {};
  for (const key of Object.keys(next)) {
    merged[key] = next[key] === null ? previous?.[key] ?? null : next[key];
  }
  return merged;
}

// The bonding curve, as a rate of travel rather than a position. A curve at 0.04
// says almost nothing on its own - every pool starts there - but 0.04 -> 0.33 in
// four minutes is the whole story, and it is the one reading a single snapshot
// can never carry. `perMinute` is the honest form of that; `stage` is only the
// coarse label a card needs.
const CURVE_LATE = 0.8;
const CURVE_MID = 0.1;

function curveOf(snapshot, latest) {
  const from = num(snapshot?.progress);
  const to = num(latest?.progress);
  if (from === null || to === null) return null;
  const minutes = Math.max(0, (Number(latest.at) - Number(snapshot.at)) / 60_000);
  const delta = to - from;
  return {
    from, to, delta,
    minutes: Math.round(minutes * 10) / 10,
    perMinute: minutes > 0 ? Math.round((delta / minutes) * 10_000) / 10_000 : null,
    stage: to >= CURVE_LATE ? 'LATE' : to >= CURVE_MID ? 'MID' : 'EARLY'
  };
}

// The other half of keeping a stored record honest: what is no longer observed
// has to leave. Exported so the retention rule can be tested as the pure function
// it is, rather than through a clock the test would have to drive for half an
// hour to observe.
//
// An entry with no readable timestamp is retired too. It cannot be placed on the
// clock, and keeping an unplaceable row forever is not caution - it is the leak.
export function pruneState(state, at, bufferMs = CLUSTER_WINDOW_MS) {
  if (!state || typeof state !== 'object') return state;
  const poolCutoff = at - Math.max(Number(bufferMs) || 0, POOL_RETENTION_MS);
  if (state.pools instanceof Map) {
    for (const [address, pool] of state.pools) {
      const seen = Number(pool?.latest?.at);
      if (!Number.isFinite(seen) || seen < poolCutoff) state.pools.delete(address);
    }
  }
  const announcedCutoff = at - REFIRE_MS;
  if (state.announced instanceof Map) {
    for (const [key, row] of state.announced) {
      const seen = Number(row?.at);
      if (!Number.isFinite(seen) || seen < announcedCutoff) state.announced.delete(key);
    }
  }
  return state;
}

// Entry and exit are not symmetric, so they do not share a rung. Three wallets
// buying is the published "strong" signal; two is worth watching. Selling is
// treated as urgent one wallet earlier, because the cost of a missed exit is
// paid immediately while a missed entry only costs an opportunity.
function classify(chain, cluster, { minWallets }) {
  const buying = cluster.side === 'buy';
  const threshold = buying ? minWallets : Math.max(2, minWallets - 1);
  if (cluster.wallets < threshold) return null;
  const closing = cluster.closes > 0;
  const strength = cluster.strength === 'VERY_STRONG' ? 'VERY_STRONG'
    : cluster.strength === 'STRONG' ? 'STRONG' : 'MEDIUM';
  return {
    kind: buying ? 'ENTRY' : 'EXIT',
    reason: buying ? 'CLUSTER_ENTRY' : closing ? 'CLUSTER_EXIT_FULL' : 'CLUSTER_EXIT_PART',
    strength,
    activity: cluster.smartMoney && cluster.kol ? 'BOTH' : cluster.kol ? 'KOL' : 'SMART'
  };
}

export class GmgnDiscovery {
  constructor({
    client = null,
    settings = config,
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    chains = null,
    bufferMs = CLUSTER_WINDOW_MS,
    // Three distinct wallets is GMGN's own published "strong" rung, and the
    // measured cluster-size distribution backs it up: across one 100-row sample
    // the rungs at >=2 would fire 23 (SOL) and 40 (BSC) times, while >=3 fires 12
    // and 15. Two is a watch, three is the documented signal - alerting on two
    // would drown the stream and the tool would stop being read.
    minWallets = 3,
    tickMs = TICK_MS
  } = {}) {
    this.client = client;
    this.settings = settings;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.chains = (Array.isArray(chains) && chains.length ? chains : settings.supportedChains || ['sol', 'bsc'])
      .filter((chain) => CHAIN_PLANS[chain]);
    this.bufferMs = Math.max(60_000, Number(bufferMs) || CLUSTER_WINDOW_MS);
    this.minWallets = Math.max(2, Number(minWallets) || 2);
    this.tickMs = Math.max(1_000, Number(tickMs) || TICK_MS);
    this.states = new Map();
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.sequence = 0;
  }

  get enabled() {
    return Boolean(this.client && this.client.enabled);
  }

  #state(chain) {
    let state = this.states.get(chain);
    if (!state) {
      state = {
        chain, pools: new Map(), trades: [], signals: [],
        status: 'WAITING', code: null, lastSuccessAt: 0, lastAttemptAt: 0,
        pollCount: 0, nextPoolAt: 0, nextTradeAt: 0,
        announced: new Map(),
        // Addresses the board asked for a price on, oldest request first. A
        // request is not a promise: the pool may already be gone, the read may
        // fail, and either way nothing is invented. It is a priority, and the
        // count of what it could not serve is reported rather than swallowed.
        priceQueue: [],
        counts: { newPool: 0, entry: 0, exit: 0, priceReads: 0, priceQueueSkipped: 0 }
      };
      this.states.set(chain, state);
    }
    return state;
  }

  start() {
    if (this.stopped) return this;
    this.#arm(0);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    return this;
  }

  #arm(delay) {
    if (this.stopped || this.timer) return;
    this.timer = this.schedule(() => { this.timer = null; void this.#tick(); }, Math.max(0, delay));
    this.timer?.unref?.();
  }

  async #tick() {
    if (this.stopped) return;
    try {
      if (!this.enabled) {
        for (const chain of this.chains) {
          const state = this.#state(chain);
          state.status = 'AUTH_REQUIRED';
        }
      } else if (this.client.cooling?.()) {
        // A provider ban is not an error of ours and must not be retried into.
        // The client owns the deadline; this layer only reports it.
        for (const chain of this.chains) {
          const state = this.#state(chain);
          state.status = 'PAUSED';
          state.code = this.client.snapshot?.().lastErrorCode || 'COOLING';
        }
      } else if (!this.running) {
        this.running = true;
        try { await this.#pollAll(); } finally { this.running = false; }
      }
    } catch {
      // A tick must never escape: the timer would stop rearming and the radar
      // would go quiet without ever saying so.
    } finally {
      this.#arm(this.tickMs);
    }
  }

  async #pollAll() {
    const at = this.now();
    for (const chain of this.chains) {
      const plan = CHAIN_PLANS[chain];
      const state = this.#state(chain);
      state.lastAttemptAt = at;
      let progressed = false;
      if (at >= state.nextTradeAt) {
        state.nextTradeAt = at + plan.tradeMs;
        progressed = (await this.#pollTrades(chain, plan)) || progressed;
      }
      if (at >= state.nextPoolAt) {
        state.nextPoolAt = at + plan.poolMs;
        progressed = (await this.#pollPools(chain, plan)) || progressed;
        // Priced after the pool poll so a lead first sighted this round can get
        // its price axis on the very next fold rather than a cycle later.
        await this.#enrichPrices(chain, state);
      }
      if (progressed) { state.lastSuccessAt = this.now(); state.status = 'READY'; state.code = null; }
      else if (state.status === 'WAITING') state.status = 'READY';
      state.pollCount++;
      pruneState(state, this.now(), this.bufferMs);
      this.#derive(chain, state);
    }
  }

  async #pollPools(chain, plan) {
    const state = this.#state(chain);
    const rows = await this.client.trenches(chain, { types: plan.types, filters: plan.poolFilters });
    if (!Array.isArray(rows)) return false;
    const at = this.now();
    for (const row of rows) {
      const existing = state.pools.get(row.address);
      if (!existing) {
        // The first sighting is frozen on purpose. Every later change is measured
        // against this snapshot, so a refresh must never overwrite it, or the
        // "what did it look like when we first saw it" question becomes
        // unanswerable retroactively.
        const facts = vetoFacts(row);
        const snapshot = { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress };
        const latest = { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress };
        const verdict = assessLead({ chain, facts });
        const pool = {
          address: row.address,
          symbol: text(row.symbol, 30),
          name: text(row.name, 80),
          firstSeenAt: at,
          // The market anchor is frozen; the verdict deliberately is not. "Can
          // this be entered" is a question about now, and the facts behind it
          // move - a creator closes a position, a bundler rate climbs. So both
          // answers are kept: `firstVeto` is what was true when the pool was
          // found, `veto` is what is true as of `vetoAt`. The pair is the useful
          // thing, because "clear when found, creator gone since" is exactly the
          // sentence a card should be able to say.
          facts,
          firstVeto: verdict,
          veto: verdict,
          vetoAt: at,
          snapshot,
          latest,
          // At the first sighting the pool has not travelled: `minutes` is zero
          // and `perMinute` is null rather than a made-up rate.
          curve: curveOf(snapshot, latest),
          createdAt: row.createdAt,
          launchpad: text(row.launchpad, 40)
        };
        state.pools.set(row.address, pool);
        this.#push(state, {
          kind: 'NEW_POOL', reason: 'FIRST_SIGHTING', chain,
          address: row.address, symbol: pool.symbol, name: pool.name,
          at, strength: null, wallets: null, amountUsd: null, closes: null,
          kol: null, smartMoney: null, activity: null,
          marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders,
          progress: row.progress, firstSeenAt: at,
          createdAt: row.createdAt, launchpad: pool.launchpad,
          veto: pool.veto, firstVeto: pool.firstVeto, curve: pool.curve
        });
        state.counts.newPool++;
      } else {
        // The price this record carries comes from the enrichment pass, not
        // from this feed: rebuilding the reading from scratch here would wipe
        // it every poll and the axis would be null at almost every fold. The
        // kept price is at most one enrichment gap old, and the next fill
        // replaces it.
        existing.latest = { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress,
          price: existing.latest?.price ?? null };
        // Only the travel is recomputed. The anchor stays put.
        existing.curve = curveOf(existing.snapshot, existing.latest);
        existing.facts = mergeFacts(existing.facts, vetoFacts(row));
        existing.veto = assessLead({ chain, facts: existing.facts });
        existing.vetoAt = at;
      }
    }
    return true;
  }

  // A price read that failed must neither erase an earlier price nor pretend a
  // price arrived, so a null response is skipped and only the attempt is
  // stamped. The prioritisation is the product's own: a lead the pre-flight
  // verdict has turned away gets no budget, and among the rest the newest lead
  // wins - the pool in its first minutes is the one this tool exists to see.
  // The board asking for a price. Called with the addresses of cards that
  // reached the board without one: those are the cards the outcome frame needs a
  // baseline for, and one read each is enough. Returns how many were accepted,
  // which is deliberately not how many will be served - a request for a pool
  // this feed no longer holds is dropped on the next drain and counted there.
  requestPrices(chain, addresses) {
    const state = this.#state(chain);
    if (!state.priceQueue) state.priceQueue = [];
    const held = new Set(state.priceQueue);
    let accepted = 0;
    for (const address of Array.isArray(addresses) ? addresses : []) {
      const key = typeof address === 'string' ? address.trim() : '';
      if (!key || held.has(key)) continue;
      if (state.priceQueue.length >= PRICE_QUEUE_MAX) break;
      held.add(key);
      state.priceQueue.push(key);
      accepted++;
    }
    return accepted;
  }

  async #enrichPrices(chain, state) {
    if (!this.enabled || typeof this.client?.tokenInfo !== 'function') return;
    const at = this.now();
    // The queue first. A card that reached the board is a claim this machine
    // made, and the measurement frame cannot hold it without a price; the
    // newest-first rotation below would otherwise get to it after the pool has
    // aged out of this feed's own 30-minute window.
    const queued = [];
    const stillWaiting = [];
    for (const address of state.priceQueue || []) {
      if (queued.length >= PRICE_QUEUE_PER_POLL) { stillWaiting.push(address); continue; }
      const pool = state.pools.get(address);
      // Gone from the feed, or priced since it was asked for: either way the
      // request is over, and it is counted rather than silently dropped.
      if (!pool) { state.counts.priceQueueSkipped++; continue; }
      if (Number.isFinite(pool.latest?.price) && Number(pool.latest.price) > 0) continue;
      queued.push(pool);
    }
    state.priceQueue = stillWaiting;
    const rotation = [...state.pools.values()]
      .filter((pool) => (pool.veto?.state ?? null) !== 'BLOCK')
      .filter((pool) => !queued.includes(pool))
      .filter((pool) => !Number.isFinite(pool.priceAt) || at - pool.priceAt >= PRICE_ENRICH_GAP_MS)
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
      .slice(0, PRICE_ENRICH_PER_POLL);
    for (const pool of [...queued, ...rotation]) {
      pool.priceAt = at;
      const info = await this.client.tokenInfo(chain, pool.address);
      if (!info || info.price === null) continue;
      // Only the price (and the holder count that rode along) is written. The
      // feed's own market_cap and liquidity readings stay the record's rulers;
      // replacing them with a second route's derivations would open the
      // mixed-ruler door this file was written to keep shut.
      pool.latest = { ...pool.latest, price: info.price,
        holders: info.holders ?? pool.latest.holders };
      // Not the anchor. `snapshot` is the frozen first sighting and stays exactly
      // what the feed reported at that moment - a later price written onto it
      // would make "what did it look like when we first saw it" unanswerable
      // after the fact. Claiming a late baseline is the tracking fold's job and
      // its documented rule (fillMissingBaselines), not this file's.
      state.counts.priceReads++;
    }
  }

  async #pollTrades(chain, plan) {
    const state = this.#state(chain);
    const [smart, kol] = await Promise.all([
      this.client.trackTrades('smartmoney', chain, { limit: 100 }),
      this.client.trackTrades('kol', chain, { limit: 100 })
    ]);
    if (!Array.isArray(smart) && !Array.isArray(kol)) return false;
    const incoming = [...(smart || []), ...(kol || [])];
    if (incoming.length) state.trades.push(...incoming);
    // Trim by the same window the cluster maths uses, so the buffer can never
    // hold rows that could not contribute to a cluster anyway.
    const cutoff = Math.floor((this.now() - this.bufferMs) / 1000);
    const kept = state.trades.filter((row) => Number(row.at) >= cutoff);
    state.trades = kept.length > MAX_TRADES ? kept.slice(-MAX_TRADES) : kept;
    return true;
  }

  // Clusters are recomputed from the whole buffer each time rather than
  // accumulated incrementally. The buffer is small, and a recomputation cannot
  // drift out of step with the rows it is supposed to describe.
  #derive(chain, state) {
    const clusters = clusterTrades(state.trades, { windowMs: this.bufferMs, now: this.now() });
    const flow = this.#flowIndex(state);
    for (const cluster of clusters) {
      const decision = classify(chain, cluster, { minWallets: this.minWallets });
      if (!decision) continue;
      const key = `${cluster.address}:${decision.kind}`;
      const previous = state.announced.get(key);
      const grew = !previous || cluster.wallets > previous.wallets;
      const cooldownOver = !previous || this.now() - previous.at >= REFIRE_MS;
      if (!grew && !cooldownOver) continue;
      state.announced.set(key, { wallets: cluster.wallets, at: this.now(), strength: decision.strength });
      const pool = state.pools.get(cluster.address);
      this.#push(state, {
        kind: decision.kind, reason: decision.reason, chain,
        address: cluster.address, symbol: text(cluster.symbol || pool?.symbol, 30), name: text(pool?.name, 80),
        at: this.now(), strength: decision.strength,
        wallets: cluster.wallets, amountUsd: cluster.amountUsd, closes: cluster.closes,
        kol: cluster.kol, smartMoney: cluster.smartMoney, activity: decision.activity,
        // A cluster is evidence about wallets, not about a pool. Where the pool
        // has been sighted its frozen anchor is attached so the card can show
        // "first seen at X, now Y" without inventing a number it never read.
        marketCap: pool?.latest.marketCap ?? null, liquidity: pool?.latest.liquidity ?? null,
        holders: pool?.latest.holders ?? null, progress: pool?.latest.progress ?? null,
        firstSeenAt: pool?.firstSeenAt ?? null,
        firstMarketCap: pool?.snapshot.marketCap ?? null, firstLiquidity: pool?.snapshot.liquidity ?? null,
        createdAt: null, launchpad: null,
        // The pool's own verdict, re-appraised with one further piece of evidence
        // the first sighting could not have had: how the wallet buffer is split
        // for this address. Same frozen facts, one more reading - this is not a
        // second opinion from a different source, which is the distinction the
        // project's no-mixed-rulers rule actually cares about.
        veto: pool ? assessLead({ chain, facts: pool.facts, flow: flow.get(cluster.address) }) : null,
        firstVeto: pool?.firstVeto ?? null,
        curve: pool?.curve ?? null
      });
      if (decision.kind === 'ENTRY') state.counts.entry++; else state.counts.exit++;
    }
  }

  // The buy/sell split per address over the same window the clusters use. Built
  // from the trade rows themselves rather than read from the provider, because a
  // one-sided book is a property of the trades: no single snapshot field can
  // express "nothing but buys has happened here".
  #flowIndex(state) {
    const cutoff = Math.floor((this.now() - this.bufferMs) / 1000);
    const index = new Map();
    for (const row of state.trades) {
      if (Number(row.at) < cutoff) continue;
      if (row.side !== 'buy' && row.side !== 'sell') continue;
      const entry = index.get(row.address) || { buys: 0, sells: 0 };
      if (row.side === 'buy') entry.buys++; else entry.sells++;
      index.set(row.address, entry);
    }
    return index;
  }

  #push(state, signal) {
    state.signals.unshift({ ...signal, id: `${state.chain}-${this.sequence++}` });
    if (state.signals.length > MAX_SIGNALS) state.signals.length = MAX_SIGNALS;
  }

  // What the tracking board consumes. This is the read side of the same state
  // the panel renders, shaped for the board's own vocabulary: `pools` are leads
  // with the anchor the feed itself froze, `flows` are the wallet clusters.
  //
  // Both are marked with `source` so the board can keep its baseline rule: a
  // record is only ever advanced by the feed that created it. Two market feeds
  // disagree on liquidity by up to 5x on the same pool, so a mixed record would
  // publish the gap between two rulers as a price move.
  observations(chain) {
    if (!CHAIN_PLANS[chain]) return { pools: [], flows: [] };
    const state = this.#state(chain);
    const at = this.now();
    // One event per address: the newest. A pool whose wallets both bought and
    // sold inside the window is reported by whichever happened last, because
    // that is the fact that is still true.
    const latest = new Map();
    for (const signal of state.signals) {
      if (signal.kind !== 'ENTRY' && signal.kind !== 'EXIT') continue;
      if (!signal.address || at - Number(signal.at) > this.bufferMs) continue;
      const previous = latest.get(signal.address);
      if (previous && Number(previous.at) >= Number(signal.at)) continue;
      latest.set(signal.address, {
        address: signal.address, kind: signal.kind, at: signal.at,
        wallets: signal.wallets, amountUsd: signal.amountUsd, closes: signal.closes,
        activity: signal.activity, strength: signal.strength
      });
    }
    return {
      pools: [...state.pools.values()].map((pool) => ({
        source: 'feed', chain, address: pool.address, symbol: pool.symbol,
        // The newest reading advances the record; the frozen first sighting is
        // handed over as the anchor so a card's baseline is the moment the feed
        // first saw the pool, not the moment a scan cycle happened to pick it up.
        // `price` rides the same reading the enrichment wrote; a sparse axis is
        // the fold's problem, and it already knows how to claim a baseline late.
        firstSeenAt: pool.firstSeenAt,
        baseline: { price: pool.snapshot.price, marketCap: pool.snapshot.marketCap,
          liquidity: pool.snapshot.liquidity, holders: pool.snapshot.holders, at: pool.firstSeenAt },
        price: pool.latest.price, marketCap: pool.latest.marketCap, liquidity: pool.latest.liquidity,
        holders: pool.latest.holders, at: pool.latest.at,
        veto: pool.veto, firstVeto: pool.firstVeto, curve: pool.curve
      })),
      flows: [...latest.values()]
    };
  }

  // The public shape. Provider names are deliberately absent: a consumer of this
  // projection should be able to render it without knowing who supplied the data,
  // and the distribution guard forbids leaking the upstream brand anyway.
  snapshot(chain) {
    const plan = CHAIN_PLANS[chain];
    const state = this.#state(chain);
    const at = this.now();
    const cooling = Boolean(this.client?.cooling?.());
    return {
      chain,
      status: this.enabled ? (cooling ? 'PAUSED' : state.status) : 'AUTH_REQUIRED',
      code: cooling ? (this.client.snapshot?.().lastErrorCode || 'COOLING') : state.code,
      enabled: this.enabled,
      execution: false,
      intervalMs: plan?.poolMs ?? null,
      tradeIntervalMs: plan?.tradeMs ?? null,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      nextPollAt: Math.min(state.nextPoolAt || Infinity, state.nextTradeAt || Infinity),
      pollCount: state.pollCount,
      poolCount: state.pools.size,
      tradeCount: state.trades.length,
      counts: { ...state.counts },
      priceReads: state.counts.priceReads || 0,
      // Requests the board made that this feed could no longer serve - usually a
      // pool that aged out before its turn came. Reported, because a queue that
      // quietly drops requests is indistinguishable from one that never got them.
      priceQueueSkipped: state.counts.priceQueueSkipped || 0,
      priceQueueDepth: (state.priceQueue || []).length,
      stale: !state.lastSuccessAt || at - state.lastSuccessAt > 5 * 60_000,
      // The anchors, newest sighting first. Both readings are exposed because
      // the pair is the point: a card that could only show the current value
      // would collapse back into a plain market list.
      pools: [...state.pools.values()]
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
        .slice(0, 100)
        .map((pool) => ({ address: pool.address, symbol: pool.symbol, name: pool.name,
          firstSeenAt: pool.firstSeenAt, first: pool.snapshot, latest: pool.latest,
          // The verdict and the curve travel with the pool, not with the signal:
          // a card that has lost its cluster still needs to say what was on the
          // record when the pool was found.
          veto: pool.veto, firstVeto: pool.firstVeto, vetoAt: pool.vetoAt, curve: pool.curve })),
      signals: state.signals.slice(0, 100)
    };
  }
}

// Constructs the engine only when a key is actually present, so a stock install
// without one keeps working exactly as before instead of spending every cycle
// reporting AUTH_REQUIRED.
export function createGmgnDiscovery({ apiKey = loadApiKey(), client, ...options } = {}) {
  if (!apiKey && !client) return null;
  // 2.2 s between requests, the floor this project holds GMGN to. It is a floor
  // and not a tuning knob: throttling there escalates to an IP ban rather than to
  // a 429, so spacing is insurance against a failure that takes the whole feed
  // down for minutes. It does not cost anything at the cadences this engine
  // actually runs - polls are spaced 25 s to 120 s apart - and the read-back
  // shares this client, so one bucket paces both discovery and measurement.
  return new GmgnDiscovery({ ...options, client: client || new GmgnClient({ apiKey, minGapMs: options.minGapMs ?? 2_200 }) });
}
