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

test('every shipped axis is backed by the discovery row, so none is permanently silent', () => {
  // The four axes are exactly the market facts an AVE trending row carries.
  // A lead whose fields are all present must be able to fire all four.
  assert.deepEqual(TRACK_AXES, ['price', 'marketCap', 'liquidity', 'holders']);
  let records = observeTracks([], [lead()], AT);
  records = observeTracks(records, [lead({ price: 0.0002, marketCap: 6_000_000, liquidity: 15_000, holders: 200 })], AT + 1000);
  const fired = new Set(records[0].signals.map(s => s.axis));
  for (const axis of TRACK_AXES) assert.ok(fired.has(axis), axis + ' must be reachable from a trending row');
});

test('an axis that was never observable stays silent instead of guessing', () => {
  const records = observeTracks([], [lead({ holders: null, liquidity: null })], AT);
  assert.deepEqual(records[0].snapshot,
    { price: 0.0001, marketCap: 20_000, liquidity: null, holders: null, at: AT });
  assert.equal(records[0].signals.length, 0);
  assert.deepEqual(trackSnapshot({ price: 0, marketCap: null, liquidity: 5, holders: 0 }),
    { price: null, marketCap: null, liquidity: 5, holders: null });
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
