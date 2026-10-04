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
//
// The value multiple answers the one question the board exists to answer - how
// many times its first-seen worth this lead is now worth - and it reads whichever
// number the lead's feed actually publishes. The market feed publishes a price,
// so the multiple is a price ratio. The discovery feed publishes no price at all
// (measured on the live board while this was written: none of 1296 feed leads
// carried one) but it does publish market cap, and a launch-pad token has a fixed
// supply, so the market-cap ratio is the same multiple. Without the fallback the
// board could not say "this one multiplied" for ninety-eight per cent of what it
// watches, and the omission was not neutral: the only rung that still fired on
// the discovery feed was holder growth, which is not the same quantity. A lead at
// thirty-two times its first sighting was crossing no rung at all - holders had
// gone *down* - while a lead at 1.3x on holders was making the board.
//
// Which reading produced the multiple travels with the signal, because the card
// has to name it: a feed lead's anchor line already says that feed publishes no
// price, and a chip calling the same number a price would contradict it.
function valueMultiple(first, last) {
  if (first?.price > 0 && last?.price > 0) return { value: last.price / first.price, basis: 'price' };
  if (first?.marketCap > 0 && last?.marketCap > 0) return { value: last.marketCap / first.marketCap, basis: 'marketCap' };
  return null;
}
const AXES = Object.freeze([
  // Multiples of the first-seen worth. The ladder never re-fires a rung.
  { key: 'price', field: 'price', rungs: Object.freeze([2, 4, 8]), armed: () => true,
    value: (first, last) => valueMultiple(first, last)?.value ?? null,
    basis: (first, last) => valueMultiple(first, last)?.basis ?? null },
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
// own window, so a feed lead the feed has stopped reporting is not a lead any
// more, it is a memory - and silence, further down, is what retires it.
//
// Raised from one hour to twenty-four for one reason: an hour is shorter than
// this machine's own measurement horizon. The outcome table reads a baseline
// back at T+5m through T+24h, so a card deleted at T+1h can only ever be
// measured on the horizons it happened to reach in its first hour - and the
// table then answers a question about impatient cards rather than about the
// board. The ceiling is what lets a slow card still be entered into the frame.
//
// The cost that kept this at an hour was a projection, and the projection was
// for the wrong number: tens of thousands of records a day per chain and a
// state file in the hundreds of megabytes is what sharing the market board's
// *week* would do. Measured on the live set while this was raised
// (2026-10-04): 40 records alive under the one-hour bound, ~950 bytes each
// serialised - so a day is on the order of a megabyte per chain, and the
// ceiling is not the clock that actually retires a feed lead anyway.
//
// What does keep a day of leads from becoming a graveyard is the board, not the
// clock: leads whose measurement is finished, and leads that have been crossed
// off, belong in the collapsed section rather than on the first screen. Both
// halves are needed - without the ceiling there is nothing to measure, and
// without the collapsed section the first screen is a list of yesterday's pools
// sorted by how thoroughly they died.
export const FEED_LEAD_RETENTION_MS = 24 * 60 * 60_000;

// A record's age is a ceiling, not a reason to keep it. A lead the market feed
// has stopped listing is not a lead any more, it is a memory - the sentence the
// feed window above is built on, applied to the other clock.
//
// Measured on the live board when this was written: every lead that went quiet
// had been observed repeatedly for at most 114 minutes before the hot list
// dropped it, and none of them came back. Seventeen of forty-nine records had
// been silent for over six hours, five of those since the minute they were
// created, and all six Solana records were a day old. Waiting out the full week
// does not keep any of them alive; it parks them in front of the reader, and
// because the board ranks a drained pool first, the graveyard is the first
// thing on screen. A pool down to a tenth of its price is a real finding once
// and clutter for the following six days.
//
// Silence this long is therefore read as the lead having ended, in two places:
// the record leaves the board, and a sighting after such a gap starts a new
// record instead of advancing the old one. The second half is not decoration.
// The board is not always watching - a chain can be switched off, or the
// provider can pause - and a record that ages through such a gap would other-
// wise come back holding an anchor from before it, so "first seen -> now" would
// be reading the gap rather than a market move. That is the same two-rulers
// hazard this file already refuses for a change of source.
export const STALE_LEAD_MS = 2 * 60 * 60_000;

const finite = value => (Number.isFinite(value) ? value : null);

// How long a record has gone without a real sighting. A record that never
// carried one falls back to its first, and a record carrying neither reads as
// infinitely silent - the same treatment the age filter gives an unreadable
// timestamp, so an unparseable row is retired rather than kept forever.
function silentFor(record, now) {
  const last = Number(record?.lastSeenAt) || Number(record?.firstSeenAt) || 0;
  return now - last;
}
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
//
// A price claimed this way is stamped with the moment it was actually learned
// (`priceObservedAt`), because the outcome frame measures elapsed time from it.
// Calling a reading that arrived hours after the first sighting a five-minute
// baseline would file an hours-long move under a five-minute bucket.
function fillMissingBaselines(snapshot, seen, reached, at) {
  for (const axis of AXES) {
    const current = snapshot[axis.field];
    if (current !== null && current !== undefined) continue;
    const observed = seen[axis.field];
    if (observed === null || observed === undefined) continue;
    if (Object.keys(reached || {}).some(id => id.startsWith(`${axis.key}:`))) continue;
    snapshot[axis.field] = observed;
    if (axis.key === 'price' && Number.isFinite(at)) snapshot.priceObservedAt = at;
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
      // An axis may name which reading produced its ratio, so the card can label
      // the signal honestly rather than assuming the axis name is the source.
      if (crossed(axis, first, last, rung)) {
        signals.push({ id, axis: axis.key, rung, value, at: now,
          ...(axis.basis ? { basis: axis.basis(first, last) } : {}) });
      }
    }
  }
  return signals;
}

// Writes newly crossed rungs into a record. It is its own function because it is
// called from two places - where a sighting arrives, and the cycle-end re-read
// below - and both must write a signal the same way: bounded log, newest first,
// and `reached` advanced so the rung never fires a second time.
function recordDueSignals(record, at, signalLimit) {
  const signals = dueTrackSignals(record, at);
  if (!signals.length) return 0;
  const reached = { ...record.reached };
  for (const signal of signals) reached[signal.id] = signal.at;
  record.reached = reached;
  record.signals = [...signals, ...(record.signals || [])].slice(0, signalLimit);
  record.lastSignalAt = Math.max(Number(record.lastSignalAt) || 0, at);
  return signals.length;
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

// The axes whose upward crossing is evidence of demand. `top10` is deliberately
// absent: supply gathering into fewer hands is a caution the card already carries
// under its own badge, not a reason to put a lead in front of a reader, and the
// same goes for a spread. `liquidity` is here only in its positive direction,
// which is why the rung's sign is tested rather than the axis alone.
const DEMAND_AXES = Object.freeze(['price', 'marketCap', 'holders', 'liquidity']);

// Whether a lead has earned a place on the board. The board is a watch list of
// what is worth entering, so a lead belongs on it when something has actually
// happened to it: a proven wallet bought, or it moved up enough for a rung of its
// own ladder to be crossed, or it is breaking out - the quadrant that reaches
// 1.5x, before the price ladder's first rung at 2x would report it.
//
// Measured on the live board when this was written: 1299 of 1317 Solana leads and
// 48 of 62 BSC ones had produced no signal at all - they had been seen and
// nothing else. That is what the reader was scrolling through, and it is not a
// smaller market on a quiet day, it is the discovery feed's arrival rate (about
// twenty-four new pools a minute on Solana) rendered as a list. A board that
// carries them cannot show the few that matter, because they are not the few.
//
// This is a *read*, not a retirement, and the difference matters. A vetoed lead
// is dropped by the fold and is gone for good - it will never become a lead, so
// nothing is lost by forgetting it. A quiet lead is not like that: it may cross a
// rung on the very next cycle, and it is quiet precisely because it is young. So
// it stays in the watch set, holding the anchor its ladder is measured from, and
// only the board it is printed on leaves it out. Dropping it from the fold would
// restart its baseline every cycle and the slow climb this product exists to
// catch would never cross a rung at all.
export function worthWatching(record, now = Date.now()) {
  if (classifyTrack(record, now) === 'BREAKOUT') return true;
  return (Array.isArray(record?.signals) ? record.signals : []).some(signal => {
    if (signal?.axis === 'flow') return signal.kind === 'ENTRY';
    const rung = Number(signal?.rung);
    return Number.isFinite(rung) && rung > 0 && DEMAND_AXES.includes(signal.axis);
  });
}

// One grade per lead, answering one question: how strong is the evidence that
// this is worth entering *now*. It reads behaviour only. The contract verdict and
// the pre-flight veto stay their own badges, for the same reason the quadrant
// keeps them apart - a clean contract must never be able to lift a lead's grade,
// and a lead whose only news is bad must not be able to hide behind a good one.
//
// The ladder is coarse on purpose. The evidence this board actually holds
// supports four distinctions, not twenty, and a finer scale would only invite a
// reader to compare two leads that differ by a rounding error.
//
//   S  a proven wallet cluster is buying *and* a demand rung has been crossed
//   A  a proven wallet cluster is buying
//   B  a demand rung was crossed - or the lead is breaking out, which reaches
//      the same place one rung earlier
//   C  evidence exists, but none of it is demand: only exits, only declines
//   D  nothing has happened to it at all
//
// The grade is not a second copy of the quadrant. The quadrant says what kind of
// move this is; the grade says how much of it there is, and the two disagree in
// the case that matters most - a lead whose price has not moved yet but whose
// wallets are already buying is a WATCH quadrant and an A grade, and that is
// exactly the lead this board exists to put in front of a reader.
export const TRACK_GRADES = Object.freeze(['S', 'A', 'B', 'C', 'D']);

export function rateTrack(record, now = Date.now()) {
  const signals = Array.isArray(record?.signals) ? record.signals : [];
  const demand = signals.filter(signal => DEMAND_AXES.includes(signal?.axis) && Number(signal?.rung) > 0);
  // The latest side the wallets are on, not the only side they were ever on: an
  // exit an hour ago must not leave a lead graded as if the money were still
  // arriving, and a buy an hour after an exit must not be buried by it.
  const buying = record?.flow?.kind === 'ENTRY';
  if (buying && demand.length) return 'S';
  if (buying) return 'A';
  const quadrant = classifyTrack(record, now);
  if (demand.length || quadrant === 'BREAKOUT') return 'B';
  // A risk quadrant is evidence of something even when no rung of its own ladder
  // happened to be crossed. A pool that has lost most of its depth, or a price
  // climbing on a supply that is draining, is the loudest thing this board can
  // carry - and grading it "nothing has happened yet" would file it under the
  // leads that had merely been seen, which is the one place a reader would never
  // look for it. C means "there is evidence and none of it is demand", and that
  // is exactly what a drain is.
  if (signals.length || quadrant === 'POOL_PULLED' || quadrant === 'DISTRIBUTION') return 'C';
  return 'D';
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
  { retentionMs = 7 * 24 * 60 * 60_000, feedRetentionMs = FEED_LEAD_RETENTION_MS,
    staleMs = STALE_LEAD_MS, signalLimit = 40, pools = [], flows = [], stats = null } = {}) {
  const quiet = Number(staleMs);
  const staleLimit = Number.isFinite(quiet) && quiet > 0 ? quiet : STALE_LEAD_MS;
  const byAddress = new Map((Array.isArray(records) ? records : []).map(row => [trackKey(row.address), { ...row }]));

  const fold = observation => {
    if (!observation?.address) return;
    const key = trackKey(observation.address);
    const found = byAddress.get(key);
    // A record the feeds stopped reporting is over, so this sighting is a new
    // lead rather than a continuation of that one: it takes a fresh anchor, a
    // fresh baseline and an empty set of crossed rungs. Carrying the old anchor
    // forward would report the silence itself as a market move.
    const previous = found && silentFor(found, now) <= staleLimit ? found : null;
    if (found && !previous) byAddress.delete(key);
    if (previous && !sharesFeed(previous, observation)) return;
    const seen = trackSnapshot(observation);
    // The anchor is copied, never mutated in place, so an already-published
    // record cannot change under a reader; then a sparse axis that was still
    // unobserved at the first sighting may claim its baseline from this one.
    const snapshot = previous?.snapshot ? fillMissingBaselines({ ...previous.snapshot }, seen, previous.reached, now) : { ...seen, at: now };
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
    recordDueSignals(record, now, signalLimit);
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
  const alive = [...byAddress.values()]
    .filter(row => now - Number(row.firstSeenAt || 0) <= (sourceOf(row.source) === 'feed' ? feedKeep : retentionMs))
    // ...and neither ceiling is what actually retires a market lead. One the
    // feeds have stopped listing is over in two hours, whether or not anyone was
    // watching at the moment it went quiet. A feed lead never reaches this
    // window - its own hour is the shorter clock, as it should be.
    .filter(row => silentFor(row, now) <= staleLimit);
  // A rung is a statement about two readings, and only one of them keeps moving.
  // The second stops the moment the feeds stop reporting the pool, so a crossing
  // that reading already shows has nobody left to announce it: the record is
  // still here, its numbers still say "three times its first sighting", and no
  // further sighting will ever arrive to say so. That is half of a feed lead's
  // life - the discovery feed reports a pool for its own window and this set
  // keeps it for twice that - so the last reading is the one that is never read.
  // Measured on the live set while this was written: eight records reading two to
  // five times their first sighting, not one of them on the board.
  //
  // Re-reading is idempotent - `reached` fires a rung once - and that is also
  // what lets a change in how a reading is *derived* reach the records stored
  // before it. Without both halves, the fix that taught the price ladder to read
  // a market cap stayed invisible on every row it had already been handed, and
  // the next such fix would have too. The stamp is the reading's own time, not
  // this cycle's, so a signal never reads fresher than the number under it.
  for (const record of alive) recordDueSignals(record, Number(record?.latest?.at) || now, signalLimit);
  // A lead the pre-flight checklist vetoed is not tracked at all. It is not a
  // lead this product would have anyone act on, so carrying it is not a smaller
  // reading of it, it is a wrong one - and the board is a watch list, not a
  // list of what to avoid.
  //
  // Measured on the live board when this was written: 22 of 84 rows were vetoed,
  // and not marginally - CREATOR_SPRAY dominated, one creator's launch count
  // above five hundred tokens on BSC, the same name repeated four times under
  // four addresses. Those rows are not a signal carrying a caveat, they are the
  // spray itself. The board ranks a drained pool first, so before this they were
  // also the first thing on screen.
  //
  // The verdict is not recomputed here (see the fold above); it is carried from
  // where the risk facts live. Two consequences worth stating. The drop happens
  // on every cycle, so nothing accumulates and no stored record needs migrating.
  // And it is *reported* through `stats`, because a board that silently shrinks
  // is indistinguishable from a quiet market - which is the exact failure the
  // neighbouring defaults were already caught having.
  const kept = alive.filter(row => row.veto?.state !== 'BLOCK');
  if (stats && typeof stats === 'object') stats.vetoed = alive.length - kept.length;
  return kept;
}

const QUADRANTS = Object.freeze(['POOL_PULLED', 'DISTRIBUTION', 'BREAKOUT', 'WATCH']);

export function summarizeTracking(records, now = Date.now(), { coolingMs = 30 * 60_000, vetoed = 0, quiet = 0, unpriced = 0, priceRequests = 0 } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const quadrants = Object.fromEntries(QUADRANTS.map(name => [name, 0]));
  // The grade distribution, tallied over the same rows as the quadrants and kept
  // beside them rather than folded in. The two answer different questions about
  // one lead - what kind of move, and how much evidence - and a board that showed
  // only one of them would let a loud mover with one thin signal outrank a quiet
  // lead the wallets were already buying.
  const grades = Object.fromEntries(TRACK_GRADES.map(name => [name, 0]));
  let cooling = 0;
  let atRisk = 0;
  let exiting = 0;
  let blocked = 0;
  for (const row of rows) {
    quadrants[classifyTrack(row, now)]++;
    grades[rateTrack(row, now)]++;
    if (now - Number(row.lastSeenAt || 0) > coolingMs) cooling++;
    // Counted separately from the quadrant for the same reason the contract
    // verdict is: "wallets are leaving" is evidence the quadrant reads, but the
    // number of leads currently carrying that evidence is its own fact.
    const exitedAt = Number(row.exitedAt);
    if (Number.isFinite(exitedAt) && exitedAt > 0 && now - exitedAt <= EXIT_ALERT_MS) exiting++;
    // Counted separately from the quadrant: a contract verdict says nothing
    // about price behaviour, and the two must not be blended into one number.
    if (row.risk?.verdict === 'FATAL') atRisk++;
    // And a third time, for a third question: the pre-flight verdict asks whether
    // a lead *should* be entered, which is neither how it is behaving nor how
    // risky its contract is, and it must not be blended into either. What the
    // number now reports is how many leads the checklist refused - the ones the
    // board therefore does not carry (see observeTracks). That cannot be read off
    // `rows`, because a vetoed lead is dropped before it ever gets here, so the
    // tally is handed in by the filter that dropped it. The scan of `rows` is
    // kept underneath it because the two sets are disjoint by construction: a
    // caller holding rows that were never filtered still gets its vetoes counted
    // rather than a silent zero.
    if (row.veto?.state === 'BLOCK') blocked++;
  }
  const signals = rows.flatMap(row => (row.signals || []).map(signal => ({ ...signal, address: row.address, symbol: row.symbol, chain: row.chain })))
    .sort((a, b) => b.at - a.at).slice(0, 20);
  return { tracked: rows.length, cooling, active: rows.length - cooling, atRisk, exiting,
    blocked: blocked + Math.max(0, Number(vetoed) || 0),
    // And a fourth count for a fourth question. These are leads the board did not
    // carry because nothing had happened to them yet, and like the vetoes their
    // tally cannot be read off `rows` - they are missing from it by definition -
    // so the caller that left them out hands the number in. Reporting it is not
    // optional: a board that shrinks in silence is indistinguishable from a quiet
    // market, which is the failure every neighbouring default here was caught in.
    quiet: Math.max(0, Number(quiet) || 0),
    // A fifth count, and the one that used to be invisible: cards the board is
    // showing that the outcome frame cannot hold because there is no price to
    // measure them from. Not a verdict, not a veto, not quiet - these leads are
    // on the board and unmeasurable, which is a different failure from any of
    // the four above and must not be reported as one of them. Handed in by the
    // sampler that could not take them.
    unpriced: Math.max(0, Number(unpriced) || 0),
    // How many of those the feed was asked to go and price. Zero next to a
    // non-zero `unpriced` means the request never reached the discovery feed -
    // a disabled provider or a full queue - and that is worth seeing too.
    priceRequests: Math.max(0, Number(priceRequests) || 0),
    quadrants, grades, recentSignals: signals };
}
