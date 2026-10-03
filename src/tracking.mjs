// Tracking is the signal lamp next to the calibration scale. Outcomes sample a
// fixed set of windows and answer "was the filter right?"; tracking watches
// named thresholds being crossed and answers "what deserves attention now?".
// The two never share a record: folding crossing events into `outcomes` would
// change the cohort that calibrationReady, median returns and coverage describe.

// Every rung is compared against a value projected from the first sighting, so
// a signal is always explainable as "first seen → now → change". A null
// projection means the axis was never observable for this lead and stays silent
// instead of being guessed.
//
// Four axes come free with a single AVE trending row: price / market_cap /
// liquidity (main_pair_tvl ?? tvl) / holders. The fifth, holder concentration,
// needs a second provider. GoPlus supplies it for roughly two thirds of tracked
// BSC leads but under a tenth of tracked Solana ones, so it is shipped as a
// *sparse* axis rather than dropped: genuinely backed where the data exists, and
// silent — never guessed — where it does not. Dropping it instead would also
// remove the concentration reading from the distribution call on BSC, where it
// is the harder evidence.
// `key` names the axis in signal ids and must stay stable; `field` is where the
// reading lives on a snapshot. They differ only for top10, whose value is the
// rate itself rather than the bare axis name.
const AXES = Object.freeze([
  // Multiples of the first-seen price. The ladder never re-fires a rung.
  { key: 'price', field: 'price', rungs: Object.freeze([2, 4, 8]), armed: () => true,
    value: (first, last) => first.price > 0 && last.price > 0 ? last.price / first.price : null },
  // Absolute market-cap milestones, counted only when crossed from below.
  { key: 'marketCap', field: 'marketCap', rungs: Object.freeze([1_000_000, 5_000_000, 10_000_000]),
    armed: (first, rung) => !(first.marketCap >= rung),
    value: (first, last) => Number.isFinite(last.marketCap) ? last.marketCap : null },
  // Liquidity as a signed change against the first sighting: a positive rung is
  // funding arriving, a negative one is the pool being pulled out. Signs encode
  // direction for every signed axis, so a positive rung is never read backwards.
  { key: 'liquidity', field: 'liquidity', rungs: Object.freeze([0.5, -0.3, -0.6]), armed: () => true,
    value: (first, last) => first.liquidity > 0 && last.liquidity > 0 ? last.liquidity / first.liquidity - 1 : null },
  // Holder growth as a ratio of the first sighting.
  { key: 'holders', field: 'holders', rungs: Object.freeze([2]), armed: () => true,
    value: (first, last) => first.holders > 0 && last.holders > 0 ? last.holders / first.holders : null },
  // Holder concentration as a signed shift in top-10 share of supply, in
  // percentage points expressed as a fraction (0.1 = ten points). Rising share
  // means supply is gathering into fewer hands.
  { key: 'top10', field: 'top10Rate', rungs: Object.freeze([0.1, -0.1]), armed: () => true,
    value: (first, last) => Number.isFinite(first.top10Rate) && Number.isFinite(last.top10Rate)
      ? last.top10Rate - first.top10Rate : null }
]);

export const TRACK_AXES = Object.freeze(AXES.map(axis => axis.key));
export const TRACK_LEVELS = Object.freeze(Object.fromEntries(AXES.map(axis => [axis.key, [...axis.rungs]])));

// EVM addresses are case-insensitive while Solana base58 mints are not, so the
// key must never be globally lower-cased.
export function trackKey(value) {
  const address = String(value ?? '').trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
}

// Wallet flow is the second kind of evidence the board carries, and it is
// deliberately *not* an axis. An axis needs a baseline and a scale so a change
// can be read against the first sighting; a cluster of proven wallets leaving is
// an event that either happened or did not. Two consequences worth stating:
//   * It is not a market reading, so it carries none of the cross-source hazard
//     the price/liquidity/holders axes carry - a statement about wallets is
//     matched to a lead by address, whoever supplied that lead's market facts.
//   * It cannot be derived from a snapshot at all. "Several wallets are selling
//     right now" is a delta over a trade feed; the number of wallets that ever
//     held the token is a different quantity that happens to share its name.
export const FLOW_KINDS = Object.freeze(['ENTRY', 'EXIT']);
export const FLOW_ACTIVITIES = Object.freeze(['BOTH', 'KOL', 'SMART']);
export const FLOW_STRENGTHS = Object.freeze(['VERY_STRONG', 'STRONG', 'MEDIUM']);
// How long an exit cluster keeps the board's warning lit. Long enough that a
// later buy cannot erase the warning before anyone has read it, short enough
// that a lead is not branded for life by one afternoon's rotation.
export const EXIT_ALERT_MS = 30 * 60_000;

// A feed lead and a market lead do not age at the same rate, so they must not
// share one clock. The market hot list lists pools that are still notable a day
// later. The discovery feed only ever knows about a pool while it is inside its
// own window - half an hour, for this chain - so a feed lead the feed has stopped
// reporting is not a lead any more, it is a memory.
//
// Sharing the market board's week would mean keeping every pool ever seen: at the
// measured arrival rate that is tens of thousands of records a day per chain, a
// state file in the hundreds of megabytes, rewritten on every cycle, and a board
// nobody can read. The bound is derived from the feed's own horizon rather than
// chosen by feel - twice the window a pool can still appear in - which is long
// enough to watch a curve travel and short enough that the board stays a board.
export const FEED_LEAD_RETENTION_MS = 60 * 60_000;

const finite = value => (Number.isFinite(value) ? value : null);
// A rate keeps zero as a real reading: "no concentration" and "no holders list
// returned" must not collapse into the same value.
const rateOrNull = value => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
};

// Only the fields that were actually observed are carried, so a missing axis
// stays missing rather than becoming a zero that later reads as a collapse.
export function trackSnapshot(observation) {
  return {
    price: finite(observation.price) > 0 ? finite(observation.price) : null,
    marketCap: finite(observation.marketCap) > 0 ? finite(observation.marketCap) : null,
    liquidity: finite(observation.liquidity) > 0 ? finite(observation.liquidity) : null,
    holders: finite(observation.holders) > 0 ? finite(observation.holders) : null,
    top10Rate: rateOrNull(observation.top10Rate)
  };
}

// A contract verdict is a current-state fact rather than a baseline, so it is
// refreshed on every sighting — but a fatal flag is never forgotten. Contracts
// do not stop being honeypots, and a later incomplete read must not erase the
// evidence that an earlier one produced.
export function mergeTrackRisk(previous, observation) {
  const next = observation?.risk;
  if (previous?.verdict === 'FATAL' && next?.verdict !== 'FATAL') return previous;
  if (!next || typeof next !== 'object') return previous || null;
  return { verdict: next.verdict || 'UNKNOWN', reasons: Array.isArray(next.reasons) ? next.reasons.slice(0, 8) : [], at: next.at };
}

// Wallet flow is refreshed on every sighting rather than accumulated, and the
// newest event wins: a later entry after an earlier exit is a real change of
// fact and must be shown as one. The exit *timestamp* is kept separately by the
// caller so the warning survives that change of fact.
export function mergeTrackFlow(previous, incoming, now = Date.now()) {
  const kind = FLOW_KINDS.includes(incoming?.kind) ? incoming.kind : null;
  if (!kind) return previous || null;
  const at = finite(incoming.at) ?? now;
  // An out-of-order event never overwrites a newer one: the trade feed can
  // deliver the same address twice and the board must not walk backwards.
  if (previous && Number(previous.at) > at) return previous;
  return {
    kind,
    at,
    wallets: finite(incoming.wallets),
    amountUsd: finite(incoming.amountUsd),
    closes: finite(incoming.closes),
    activity: FLOW_ACTIVITIES.includes(incoming.activity) ? incoming.activity : null,
    strength: FLOW_STRENGTHS.includes(incoming.strength) ? incoming.strength : null
  };
}

// A sparse axis — one the provider only answers for some leads — must not be
// silenced for a lead's whole life by an unlucky first cycle. An axis's baseline
// is the first sighting in which that axis was *observable*, so a still-missing
// anchor value is filled from the first sighting that carries it. This is bounded
// to axes that have produced no signal yet, which is what keeps the "the
// baseline a card shows is never silently rewritten" guarantee intact.
function fillMissingBaselines(snapshot, seen, reached) {
  for (const axis of AXES) {
    const current = snapshot[axis.field];
    if (current !== null && current !== undefined) continue;
    const observed = seen[axis.field];
    if (observed === null || observed === undefined) continue;
    if (Object.keys(reached || {}).some(id => id.startsWith(`${axis.key}:`))) continue;
    snapshot[axis.field] = observed;
  }
  return snapshot;
}

function crossed(axis, first, last, rung) {
  const value = axis.value(first, last);
  if (value === null || !axis.armed(first, rung)) return null;
  // A negative rung is a floor to break through, a positive one a ceiling.
  return rung >= 0 ? value >= rung : value <= rung;
}

// Rungs a lead has newly crossed. `reached` keeps each rung firing once, so a
// price that falls back and recovers is not reported as a second breakout.
export function dueTrackSignals(record, now = Date.now()) {
  const first = record?.snapshot, last = record?.latest;
  if (!first || !last) return [];
  const signals = [];
  for (const axis of AXES) {
    for (const rung of axis.rungs) {
      const id = `${axis.key}:${rung}`;
      if (record.reached?.[id]) continue;
      const value = axis.value(first, last);
      if (value === null) continue;
      if (crossed(axis, first, last, rung)) signals.push({ id, axis: axis.key, rung, value, at: now });
    }
  }
  return signals;
}

// A passing chain-review gate is a contract-safety verdict; the quadrant is a
// market-behaviour one. They are deliberately reported as separate badges so a
// quiet token with a clean contract never reads as a live opportunity.
//
// Outcome, in risk-first order: POOL_PULLED > DISTRIBUTION > BREAKOUT > WATCH.
export function classifyTrack(record, now = Date.now()) {
  const first = record?.snapshot, last = record?.latest;
  if (!first || !last) return 'WATCH';
  const liquidity = first.liquidity > 0 && last.liquidity > 0 ? last.liquidity / first.liquidity : null;
  const price = first.price > 0 && last.price > 0 ? last.price / first.price : null;
  // Risk reads first: a pool already being pulled is not a breakout.
  if (liquidity !== null && liquidity <= 0.4) return 'POOL_PULLED';
  // A cluster of proven wallets leaving is distribution observed *before* the
  // price admits it, which is the whole reason the trade feed is read at all:
  // the wallets move on the way out and the chart moves after them. It is placed
  // after POOL_PULLED because a pool that has actually been drained is the
  // stronger fact, and ahead of the price test because a warning that waits for
  // the price to confirm it has already missed the exit it exists to announce.
  const exitedAt = Number(record?.exitedAt);
  if (Number.isFinite(exitedAt) && exitedAt > 0 && now - exitedAt <= EXIT_ALERT_MS) return 'DISTRIBUTION';
  const concentrating = Number.isFinite(first.top10Rate) && Number.isFinite(last.top10Rate)
    && last.top10Rate - first.top10Rate >= 0.1;
  // Distribution is a price that keeps climbing while the supply underneath it
  // stops being widely held. Two independent readings of the same idea, either
  // of which is enough: pool depth failing to keep up (always available), or the
  // top-10 share visibly gathering (available where the provider answers). Taking
  // either keeps the quadrant reachable on a chain where concentration is not
  // reported, instead of leaving it dead.
  const draining = liquidity !== null && liquidity < 1;
  if (price !== null && price >= 1.2 && (concentrating || draining)) return 'DISTRIBUTION';
  if (price !== null && price >= 1.5 && (liquidity === null || liquidity >= 1)) return 'BREAKOUT';
  return 'WATCH';
}

// Reads which feed supplied a lead's market facts. Two feeds do not agree on
// scale — the calibration run measured the same pool's liquidity differing by up
// to 5x — so a record may only be advanced by the feed that set its baseline.
// Folding a second feed in would render the gap between two rulers as a market
// move, and the resulting card would be neither feed's reading. Records written
// before this field existed, and observations that leave it unset, are treated
// as the market feed, which is the single-feed behaviour they were created under.
const sourceOf = value => (typeof value === 'string' && value ? value : 'market');
const sharesFeed = (record, observation) => sourceOf(record?.source) === sourceOf(observation?.source);

// Folds this cycle's observations into the tracking set. A first sighting fixes
// the snapshot and anchor; later sightings only advance `latest`, so the
// baseline a card shows is never silently rewritten.
//
// Three lists, applied in this order for a reason:
//   observations  the market feed's leads. Folded first so an already-known lead
//                 keeps the baseline and feed it was created with.
//   pools         leads the *discovery* feed saw, which the market feed never
//                 lists — a hot list carries no pool young enough to matter. They
//                 can only ever create a record or advance one they created; a
//                 pool this feed saw cannot displace a market baseline, and a
//                 market lead cannot be advanced by this feed (see sharesFeed).
//   flows         wallet-cluster events, attached by address to whatever record
//                 already exists. They never create a record: a wallet moving is
//                 not evidence that this product observed a pool, and a baseline
//                 invented out of a trade would make every card's anchor a guess.
export function observeTracks(records, observations, now = Date.now(),
  { retentionMs = 7 * 24 * 60 * 60_000, feedRetentionMs = FEED_LEAD_RETENTION_MS, signalLimit = 40, pools = [], flows = [] } = {}) {
  const byAddress = new Map((Array.isArray(records) ? records : []).map(row => [trackKey(row.address), { ...row }]));

  const fold = observation => {
    if (!observation?.address) return;
    const key = trackKey(observation.address);
    const previous = byAddress.get(key);
    if (previous && !sharesFeed(previous, observation)) return;
    const seen = trackSnapshot(observation);
    // The anchor is copied, never mutated in place, so an already-published
    // record cannot change under a reader; then a sparse axis that was still
    // unobserved at the first sighting may claim its baseline from this one.
    const snapshot = previous?.snapshot ? fillMissingBaselines({ ...previous.snapshot }, seen, previous.reached) : { ...seen, at: now };
    const latest = { ...seen, at: now };
    const risk = mergeTrackRisk(previous?.risk, { risk: observation.risk, at: now });
    // The verdict is carried but never recomputed here. It is made where the risk
    // facts live; the board's job is to show it beside the market axis, not to
    // form a second opinion out of numbers it does not hold. An observation that
    // arrives without one - the market feed never has one - leaves the last real
    // answer in place rather than clearing it.
    const verdict = observation.veto ?? previous?.veto ?? null;
    const firstVerdict = observation.firstVeto ?? previous?.firstVeto ?? null;
    const curve = observation.curve ?? previous?.curve ?? null;
    let record;
    if (previous) {
      record = { ...previous, snapshot, latest, risk, lastSeenAt: now, symbol: observation.symbol || previous.symbol,
        veto: verdict, firstVeto: firstVerdict, curve };
    } else {
      // A feed that already holds an earlier reading of its own may hand it over
      // as the anchor. The board's promise is "first sighting", and the honest
      // first sighting is the feed's, not the moment this cycle happened to pick
      // it up — anything else would hide a move that happened in between. The
      // anchor's timestamp is only taken from the feed alongside the reading it
      // belongs to: stamping today's numbers with an older time would be a worse
      // lie than admitting the board only started watching now.
      const anchorAt = observation.baseline ? (finite(observation.firstSeenAt) ?? now) : now;
      const anchor = observation.baseline ? trackSnapshot(observation.baseline) : seen;
      record = { chain: observation.chain || '', address: String(observation.address), symbol: observation.symbol || '',
        source: sourceOf(observation.source), firstSeenAt: anchorAt, lastSeenAt: now,
        snapshot: { ...anchor, at: anchorAt }, latest, risk, reached: {}, signals: [],
        veto: verdict, firstVeto: firstVerdict, curve };
    }
    const signals = dueTrackSignals(record, now);
    if (signals.length) {
      const reached = { ...record.reached };
      for (const signal of signals) reached[signal.id] = signal.at;
      record.reached = reached;
      record.signals = [...signals, ...(record.signals || [])].slice(0, signalLimit);
      record.lastSignalAt = now;
    }
    byAddress.set(key, record);
  };

  for (const observation of observations || []) fold(observation);
  for (const pool of pools || []) fold(pool);

  // A flow event is matched by address alone, which is safe for the two chains
  // this product covers: BSC is `0x`-hex and Solana is base58, so one address can
  // never name a token on both at once.
  for (const flow of flows || []) {
    if (!flow?.address) continue;
    const record = byAddress.get(trackKey(flow.address));
    if (!record) continue;
    const merged = mergeTrackFlow(record.flow, flow, now);
    if (!merged) continue;
    const announced = record.flow && record.flow.kind === merged.kind && Number(record.flow.at) === Number(merged.at);
    record.flow = merged;
    // The exit timestamp is kept apart from the latest event so a buy arriving a
    // minute after the cluster left cannot switch the warning off before it was
    // read. A later entry still replaces `flow` itself: that change of fact is
    // real and the card must be able to show it.
    if (merged.kind === 'EXIT') record.exitedAt = Math.max(Number(record.exitedAt) || 0, merged.at);
    if (announced) continue;
    record.signals = [{ id: `flow:${merged.kind}`, axis: 'flow', kind: merged.kind,
      rung: merged.wallets, value: merged.amountUsd, at: merged.at }, ...(record.signals || [])].slice(0, signalLimit);
    if (merged.at > Number(record.lastSignalAt || 0)) record.lastSignalAt = merged.at;
  }

  // Two retention clocks, spent per record. A lead's source is fixed when the
  // record is created and never changes (see `sharesFeed`), so it is knowable
  // here without asking which feed last touched it. A feed lead is never allowed
  // to outlive a market one, even if a caller asks for a longer window than the
  // board's own: it would be the same hoard under a different name.
  const feedKeep = Math.min(Number(feedRetentionMs) || retentionMs, retentionMs);
  return [...byAddress.values()]
    .filter(row => now - Number(row.firstSeenAt || 0) <= (sourceOf(row.source) === 'feed' ? feedKeep : retentionMs));
}

const QUADRANTS = Object.freeze(['POOL_PULLED', 'DISTRIBUTION', 'BREAKOUT', 'WATCH']);

export function summarizeTracking(records, now = Date.now(), { coolingMs = 30 * 60_000 } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const quadrants = Object.fromEntries(QUADRANTS.map(name => [name, 0]));
  let cooling = 0;
  let atRisk = 0;
  let exiting = 0;
  let blocked = 0;
  for (const row of rows) {
    quadrants[classifyTrack(row, now)]++;
    if (now - Number(row.lastSeenAt || 0) > coolingMs) cooling++;
    // Counted separately from the quadrant for the same reason the contract
    // verdict is: "wallets are leaving" is evidence the quadrant reads, but the
    // number of leads currently carrying that evidence is its own fact.
    const exitedAt = Number(row.exitedAt);
    if (Number.isFinite(exitedAt) && exitedAt > 0 && now - exitedAt <= EXIT_ALERT_MS) exiting++;
    // Counted separately from the quadrant: a contract verdict says nothing
    // about price behaviour, and the two must not be blended into one number.
    if (row.risk?.verdict === 'FATAL') atRisk++;
    // And a third time, for a third question. The pre-flight verdict asks whether
    // a lead *should* be entered; the quadrant asks how it is behaving. A lead
    // can be vetoed at discovery and still be the best mover on the board, and
    // collapsing those into one number would lose both readings.
    if (row.veto?.state === 'BLOCK') blocked++;
  }
  const signals = rows.flatMap(row => (row.signals || []).map(signal => ({ ...signal, address: row.address, symbol: row.symbol, chain: row.chain })))
    .sort((a, b) => b.at - a.at).slice(0, 20);
  return { tracked: rows.length, cooling, active: rows.length - cooling, atRisk, exiting, blocked, quadrants, recentSignals: signals };
}
