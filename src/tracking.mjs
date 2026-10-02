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
// Only the four fields a single AVE trending row actually carries are shipped:
// price / market_cap / liquidity (main_pair_tvl ?? tvl) / holders. A fifth axis
// for holder concentration was designed but has no source in the discovery path
// (AVE omits it; GoPlus would supply it at a request cost this cycle cannot
// afford), so it is deliberately absent rather than permanently silent — an axis
// that can never fire would also leave its quadrant unreachable.
const AXES = Object.freeze([
  // Multiples of the first-seen price. The ladder never re-fires a rung.
  { key: 'price', rungs: Object.freeze([2, 4, 8]), armed: () => true,
    value: (first, last) => first.price > 0 && last.price > 0 ? last.price / first.price : null },
  // Absolute market-cap milestones, counted only when crossed from below.
  { key: 'marketCap', rungs: Object.freeze([1_000_000, 5_000_000, 10_000_000]),
    armed: (first, rung) => !(first.marketCap >= rung),
    value: (first, last) => Number.isFinite(last.marketCap) ? last.marketCap : null },
  // Liquidity as a signed change against the first sighting: a positive rung is
  // funding arriving, a negative one is the pool being pulled out. Signs encode
  // direction for every signed axis, so a positive rung is never read backwards.
  { key: 'liquidity', rungs: Object.freeze([0.5, -0.3, -0.6]), armed: () => true,
    value: (first, last) => first.liquidity > 0 && last.liquidity > 0 ? last.liquidity / first.liquidity - 1 : null },
  // Holder growth as a ratio of the first sighting.
  { key: 'holders', rungs: Object.freeze([2]), armed: () => true,
    value: (first, last) => first.holders > 0 && last.holders > 0 ? last.holders / first.holders : null }
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

// Only the fields that were actually observed are carried, so a missing axis
// stays missing rather than becoming a zero that later reads as a collapse.
export function trackSnapshot(observation) {
  return {
    price: finite(observation.price) > 0 ? finite(observation.price) : null,
    marketCap: finite(observation.marketCap) > 0 ? finite(observation.marketCap) : null,
    liquidity: finite(observation.liquidity) > 0 ? finite(observation.liquidity) : null,
    holders: finite(observation.holders) > 0 ? finite(observation.holders) : null
  };
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
export function classifyTrack(record, now = Date.now()) {
  const first = record?.snapshot, last = record?.latest;
  if (!first || !last) return 'WATCH';
  const liquidity = first.liquidity > 0 && last.liquidity > 0 ? last.liquidity / first.liquidity : null;
  const price = first.price > 0 && last.price > 0 ? last.price / first.price : null;
  // Risk reads first: a pool already being pulled is not a breakout.
  if (liquidity !== null && liquidity <= 0.4) return 'POOL_PULLED';
  // A price that keeps climbing while pool depth shrinks is money leaving into
  // strength: the rally is no longer carried by the pool underneath it. This is
  // the classic AMM reading of distribution and needs no extra data source.
  if (price !== null && price >= 1.2 && liquidity !== null && liquidity < 1) return 'DISTRIBUTION';
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
    const snapshot = previous?.snapshot || { ...seen, at: now };
    const latest = { ...seen, at: now };
    const record = previous
      ? { ...previous, snapshot, latest, lastSeenAt: now, symbol: observation.symbol || previous.symbol }
      : { chain: observation.chain || '', address: String(observation.address), symbol: observation.symbol || '',
        firstSeenAt: now, lastSeenAt: now, snapshot, latest, reached: {}, signals: [] };
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
  for (const row of rows) {
    quadrants[classifyTrack(row, now)]++;
    if (now - Number(row.lastSeenAt || 0) > coolingMs) cooling++;
  }
  const signals = rows.flatMap(row => (row.signals || []).map(signal => ({ ...signal, address: row.address, symbol: row.symbol, chain: row.chain })))
    .sort((a, b) => b.at - a.at).slice(0, 20);
  return { tracked: rows.length, cooling, active: rows.length - cooling, quadrants, recentSignals: signals };
}
