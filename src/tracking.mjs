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

// Folds this cycle's observations into the tracking set. A first sighting fixes
// the snapshot and anchor; later sightings only advance `latest`, so the
// baseline a card shows is never silently rewritten.
export function observeTracks(records, observations, now = Date.now(), { retentionMs = 7 * 24 * 60 * 60_000, signalLimit = 40 } = {}) {
  const byAddress = new Map((Array.isArray(records) ? records : []).map(row => [trackKey(row.address), { ...row }]));
  for (const observation of observations || []) {
    if (!observation?.address) continue;
    const key = trackKey(observation.address);
    const previous = byAddress.get(key);
    const seen = trackSnapshot(observation);
    // The anchor is copied, never mutated in place, so an already-published
    // record cannot change under a reader; then a sparse axis that was still
    // unobserved at the first sighting may claim its baseline from this one.
    const snapshot = previous?.snapshot ? fillMissingBaselines({ ...previous.snapshot }, seen, previous.reached) : { ...seen, at: now };
    const latest = { ...seen, at: now };
    const risk = mergeTrackRisk(previous?.risk, { risk: observation.risk, at: now });
    const record = previous
      ? { ...previous, snapshot, latest, risk, lastSeenAt: now, symbol: observation.symbol || previous.symbol }
      : { chain: observation.chain || '', address: String(observation.address), symbol: observation.symbol || '',
        firstSeenAt: now, lastSeenAt: now, snapshot, latest, risk, reached: {}, signals: [] };
    const signals = dueTrackSignals(record, now);
    if (signals.length) {
      const reached = { ...record.reached };
      for (const signal of signals) reached[signal.id] = signal.at;
      record.reached = reached;
      record.signals = [...signals, ...(record.signals || [])].slice(0, signalLimit);
      record.lastSignalAt = now;
    }
    byAddress.set(key, record);
  }
  return [...byAddress.values()].filter(row => now - Number(row.firstSeenAt || 0) <= retentionMs);
}

const QUADRANTS = Object.freeze(['POOL_PULLED', 'DISTRIBUTION', 'BREAKOUT', 'WATCH']);

export function summarizeTracking(records, now = Date.now(), { coolingMs = 30 * 60_000 } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const quadrants = Object.fromEntries(QUADRANTS.map(name => [name, 0]));
  let cooling = 0;
  let atRisk = 0;
  for (const row of rows) {
    quadrants[classifyTrack(row, now)]++;
    if (now - Number(row.lastSeenAt || 0) > coolingMs) cooling++;
    // Counted separately from the quadrant: a contract verdict says nothing
    // about price behaviour, and the two must not be blended into one number.
    if (row.risk?.verdict === 'FATAL') atRisk++;
  }
  const signals = rows.flatMap(row => (row.signals || []).map(signal => ({ ...signal, address: row.address, symbol: row.symbol, chain: row.chain })))
    .sort((a, b) => b.at - a.at).slice(0, 20);
  return { tracked: rows.length, cooling, active: rows.length - cooling, atRisk, quadrants, recentSignals: signals };
}
