import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTracks, classifyTrack, summarizeTracking, trackSnapshot, trackKey, TRACK_AXES } from '../src/tracking.mjs';

const AT = Date.UTC(2026, 9, 2, 12, 0, 0);
const EVM = '0x1111111111111111111111111111111111111111';
const lead = (over = {}) => ({ chain: 'bsc', address: EVM, symbol: 'FISH',
  price: 0.0001, marketCap: 20_000, liquidity: 10_000, holders: 100, ...over });

test('the address key lower-cases EVM addresses but preserves Solana mints', () => {
  assert.equal(trackKey('0xABCdef0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
  assert.equal(trackKey('So11111111111111111111111111111111111111112'), 'So11111111111111111111111111111111111111112');
});

test('the first sighting fixes the anchor and later observations never rewrite it', () => {
  const first = observeTracks([], [lead()], AT);
  assert.equal(first.length, 1);
  const anchor = structuredClone(first[0].snapshot);
  assert.equal(anchor.at, AT);
  assert.equal(anchor.price, 0.0001);

  const later = observeTracks(first, [lead({ price: 0.0002, marketCap: 40_000, liquidity: 20_000, holders: 200 })], AT + 60_000);
  assert.deepEqual(later[0].snapshot, anchor, 'the baseline a card shows must never move');
  assert.equal(later[0].latest.price, 0.0002);
  assert.equal(later[0].firstSeenAt, AT);
  assert.equal(later[0].lastSeenAt, AT + 60_000);
});

test('each price rung fires once and a recovery does not re-fire it', () => {
  let records = observeTracks([], [lead()], AT);
  records = observeTracks(records, [lead({ price: 0.0002 })], AT + 1000);
  assert.deepEqual(records[0].signals.map(s => s.id), ['price:2']);

  records = observeTracks(records, [lead({ price: 0.00005 })], AT + 2000);
  records = observeTracks(records, [lead({ price: 0.00021 })], AT + 3000);
  assert.equal(records[0].signals.filter(s => s.id === 'price:2').length, 1, 'a recovered rung is not a new breakout');

  records = observeTracks(records, [lead({ price: 0.0004 })], AT + 4000);
  assert.deepEqual(records[0].signals.map(s => s.id).sort(), ['price:2', 'price:4']);
});

test('a market-cap milestone already met at first sight was never crossed', () => {
  const above = observeTracks([], [lead({ marketCap: 2_000_000 })], AT);
  assert.equal(above[0].signals.length, 0, 'starting above 1M is not a crossing');

  const records = observeTracks(above, [lead({ marketCap: 6_000_000 })], AT + 1000);
  assert.deepEqual(records[0].signals.map(s => s.id), ['marketCap:5000000'], 'only the genuinely crossed rung fires');
});

test('ratio and shift axes are measured against the first sighting', () => {
  let records = observeTracks([], [lead()], AT);
  records = observeTracks(records, [lead({ liquidity: 15_000, holders: 250 })], AT + 1000);
  const ids = records[0].signals.map(s => s.id);
  assert.ok(ids.includes('liquidity:0.5'), 'funding in by half is a signal');
  assert.ok(ids.includes('holders:2'), 'doubling the holder count is a signal');

  records = observeTracks(records, [lead({ liquidity: 6_000 })], AT + 2000);
  assert.ok(records[0].signals.some(s => s.id === 'liquidity:-0.3'), 'liquidity being pulled is the other direction of the same axis');
});

test('the four market axes are backed by the discovery row, and the sparse one is backed by the provider', () => {
  assert.deepEqual(TRACK_AXES, ['price', 'marketCap', 'liquidity', 'holders', 'top10']);
  let records = observeTracks([], [lead()], AT);
  records = observeTracks(records, [lead({ price: 0.0002, marketCap: 6_000_000, liquidity: 15_000, holders: 200 })], AT + 1000);
  const fired = new Set(records[0].signals.map(s => s.axis));
  for (const axis of ['price', 'marketCap', 'liquidity', 'holders']) {
    assert.ok(fired.has(axis), axis + ' must be reachable from a trending row alone');
  }

  // The fifth axis needs the holder distribution, which is why it is allowed to
  // stay silent: it fires only once that reading actually arrives.
  assert.equal(fired.has('top10'), false, 'concentration cannot fire without a distribution');
  records = observeTracks([], [lead({ top10Rate: 0.2 })], AT);
  assert.equal(records[0].signals.length, 0, 'a baseline reading is not itself a crossing');
  records = observeTracks(records, [lead({ top10Rate: 0.35 })], AT + 1000);
  assert.ok(records[0].signals.some(s => s.id === 'top10:0.1'), 'a ten-point rise in top-10 share is a signal');
  records = observeTracks(records, [lead({ top10Rate: 0.1 })], AT + 2000);
  assert.ok(records[0].signals.some(s => s.id === 'top10:-0.1'), 'and the fall is the same axis, other direction');
});

test('an axis that was never observable stays silent instead of guessing', () => {
  const records = observeTracks([], [lead({ holders: null, liquidity: null, top10Rate: null })], AT);
  assert.deepEqual(records[0].snapshot,
    { price: 0.0001, marketCap: 20_000, liquidity: null, holders: null, top10Rate: null, at: AT });
  assert.equal(records[0].signals.length, 0);
  assert.deepEqual(trackSnapshot({ price: 0, marketCap: null, liquidity: 5, holders: 0, top10Rate: 0 }),
    { price: null, marketCap: null, liquidity: 5, holders: null, top10Rate: 0 },
    'zero concentration is a real reading, while a missing one is not');
});

test('a sparse axis claims its baseline from the first sighting that carries it', () => {
  // The provider answers for some leads and not others, so an unlucky first
  // cycle must not silence the axis for the lead's whole life.
  let records = observeTracks([], [lead({ top10Rate: null })], AT);
  assert.equal(records[0].snapshot.top10Rate, null);
  records = observeTracks(records, [lead({ top10Rate: 0.25 })], AT + 1000);
  assert.equal(records[0].snapshot.top10Rate, 0.25, 'the first observable sighting becomes the baseline');
  assert.equal(records[0].signals.length, 0, 'establishing a baseline is not itself a crossing');

  // ...and it is still measured from that later baseline, not the original one.
  records = observeTracks(records, [lead({ top10Rate: 0.4 })], AT + 2000);
  assert.ok(records[0].signals.some(s => s.id === 'top10:0.1'));

  // Once the axis has fired, its baseline is frozen like any other.
  const frozen = structuredClone(records[0].snapshot);
  records = observeTracks(records, [lead({ top10Rate: 0.25 })], AT + 3000);
  assert.deepEqual(records[0].snapshot, frozen);
});

test('the quadrant reads risk before opportunity', () => {
  const snapshot = { price: 1, marketCap: 100, liquidity: 100, holders: 10 };
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 3, liquidity: 30 } }), 'POOL_PULLED',
    'a pool being pulled outranks a rising price');
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 2, liquidity: 80 } }), 'DISTRIBUTION',
    'a price climbing while pool depth shrinks is distribution into strength');
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 2, liquidity: 150 } }), 'BREAKOUT');
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 1.1, liquidity: 80 } }), 'WATCH');
});

test('distribution is reachable from concentration alone, so a chain without pool data is not left dead', () => {
  const snapshot = { price: 1, marketCap: 100, liquidity: null, holders: 10, top10Rate: 0.2 };
  // Pool depth unknown, but supply visibly gathering while price climbs.
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 1.5, top10Rate: 0.35 } }), 'DISTRIBUTION');
  // Neither reading available: concentration cannot assert it, so the weaker
  // breakout rule applies rather than a distribution claim built on nothing.
  assert.equal(classifyTrack({ snapshot: { ...snapshot, top10Rate: null }, latest: { ...snapshot, price: 1.5, top10Rate: null } }), 'BREAKOUT');
  // Concentration rising while the price is flat is not distribution: nothing is
  // being sold into strength yet.
  assert.equal(classifyTrack({ snapshot, latest: { ...snapshot, price: 1.05, top10Rate: 0.35 } }), 'WATCH');
});

test('a fatal contract verdict is never forgotten', () => {
  const risk = verdict => ({ verdict, reasons: verdict === 'FATAL' ? ['isHoneypot'] : [], at: AT });
  let records = observeTracks([], [lead({ risk: risk('FATAL') })], AT);
  assert.equal(records[0].risk.verdict, 'FATAL');

  // A later read that could not resolve the flags must not launder the verdict.
  records = observeTracks(records, [lead({ risk: risk('UNKNOWN') })], AT + 1000);
  assert.equal(records[0].risk.verdict, 'FATAL', 'contracts do not stop being honeypots');
  const summary = summarizeTracking(records, AT + 2000);
  assert.equal(summary.atRisk, 1, 'and the risk count agrees');
});

test('the signal log is bounded and keeps the newest signal first', () => {
  const options = { signalLimit: 2 };
  let records = observeTracks([], [lead()], AT, options);
  for (let index = 1; index <= 4; index++) {
    records = observeTracks(records, [lead({ price: 0.0001 * 2 ** (index * 2) })], AT + index * 1000, options);
  }
  assert.equal(records[0].signals.length, 2, 'the log is bounded');
  assert.equal(records[0].signals[0].id, 'price:8', 'the newest signal is kept first');
});

test('records outside the retention window are dropped and the summary agrees', () => {
  const other = '0x' + '2'.repeat(40);
  const options = { retentionMs: 60_000 };
  let records = observeTracks([], [lead()], AT, options);
  // The expired lead is dropped; the fresh one keeps its own anchor, so its
  // first sighting is the later timestamp rather than the retired lead's.
  records = observeTracks(records, [lead({ address: other, price: 0.0002 })], AT + 120_000, options);
  assert.equal(records.length, 1, 'the expired lead is dropped');
  assert.equal(records[0].address, other);
  assert.equal(records[0].firstSeenAt, AT + 120_000);

  // It only reads as a breakout once a later sighting actually moves it.
  records = observeTracks(records, [lead({ address: other, price: 0.0004, liquidity: 30_000 })], AT + 180_000, options);
  const summary = summarizeTracking(records, AT + 181_000, { coolingMs: 30 * 60_000 });
  assert.equal(summary.tracked, 1);
  assert.equal(summary.active, 1);
  assert.equal(summary.cooling, 0);
  assert.equal(summary.quadrants.BREAKOUT, 1);
  assert.ok(summary.recentSignals.length >= 1);

  const cooling = summarizeTracking(records, AT + 3_600_000, { coolingMs: 30 * 60_000 });
  assert.equal(cooling.cooling, 1, 'a lead that stopped being observed is cooling, not deleted');
  assert.equal(cooling.active, 0);
});
