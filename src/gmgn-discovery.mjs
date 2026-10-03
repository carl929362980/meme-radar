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
// A cluster may only re-announce itself when it has actually grown, or when this
// much time has passed. Without the second clause a cluster that stays at three
// wallets would fall silent, which is how a real accumulation gets missed.
const REFIRE_MS = 15 * 60_000;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

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
        counts: { newPool: 0, entry: 0, exit: 0 }
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
      }
      if (progressed) { state.lastSuccessAt = this.now(); state.status = 'READY'; state.code = null; }
      else if (state.status === 'WAITING') state.status = 'READY';
      state.pollCount++;
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
        state.pools.set(row.address, {
          address: row.address,
          symbol: text(row.symbol, 30),
          name: text(row.name, 80),
          firstSeenAt: at,
          snapshot: { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress },
          latest: { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress }
        });
        this.#push(state, {
          kind: 'NEW_POOL', reason: 'FIRST_SIGHTING', chain,
          address: row.address, symbol: text(row.symbol, 30), name: text(row.name, 80),
          at, strength: null, wallets: null, amountUsd: null, closes: null,
          kol: null, smartMoney: null, activity: null,
          marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders,
          progress: row.progress, firstSeenAt: at,
          createdAt: row.createdAt, launchpad: text(row.launchpad, 40)
        });
        state.counts.newPool++;
      } else {
        existing.latest = { at, marketCap: row.marketCap, liquidity: row.liquidity, holders: row.holders, progress: row.progress };
      }
    }
    return true;
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
        createdAt: null, launchpad: null
      });
      if (decision.kind === 'ENTRY') state.counts.entry++; else state.counts.exit++;
    }
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
        firstSeenAt: pool.firstSeenAt,
        baseline: { marketCap: pool.snapshot.marketCap, liquidity: pool.snapshot.liquidity,
          holders: pool.snapshot.holders, at: pool.firstSeenAt },
        marketCap: pool.latest.marketCap, liquidity: pool.latest.liquidity,
        holders: pool.latest.holders, at: pool.latest.at
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
      stale: !state.lastSuccessAt || at - state.lastSuccessAt > 5 * 60_000,
      // The anchors, newest sighting first. Both readings are exposed because
      // the pair is the point: a card that could only show the current value
      // would collapse back into a plain market list.
      pools: [...state.pools.values()]
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
        .slice(0, 100)
        .map((pool) => ({ address: pool.address, symbol: pool.symbol, name: pool.name,
          firstSeenAt: pool.firstSeenAt, first: pool.snapshot, latest: pool.latest })),
      signals: state.signals.slice(0, 100)
    };
  }
}

// Constructs the engine only when a key is actually present, so a stock install
// without one keeps working exactly as before instead of spending every cycle
// reporting AUTH_REQUIRED.
export function createGmgnDiscovery({ apiKey = loadApiKey(), client, ...options } = {}) {
  if (!apiKey && !client) return null;
  return new GmgnDiscovery({ ...options, client: client || new GmgnClient({ apiKey, minGapMs: options.minGapMs ?? 1_200 }) });
}
