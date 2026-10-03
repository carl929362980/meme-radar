import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTracks, classifyTrack, summarizeTracking, trackSnapshot, trackKey, TRACK_AXES, EXIT_ALERT_MS } from '../src/tracking.mjs';

const AT = Date.UTC(2026, 9, 2, 12, 0, 0);
const EVM = '0x1111111111111111111111111111111111111111';
const lead = (over = {}) => ({ chain: 'bsc', address: EVM, symbol: 'FISH',
  price: 0.0001, marketCap: 20_000, liquidity: 10_000, holders: 100, ...over });
const cluster = (over = {}) => ({ chain: 'bsc', address: EVM, kind: 'EXIT', at: AT,
  wallets: 3, amountUsd: 1_234, closes: 2, activity: 'BOTH', strength: 'STRONG', ...over });

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

test('a feed lead ages on the feed\'s clock while a market lead keeps the board\'s', () => {
  const feedLead = { chain: 'bsc', address: EVM, symbol: 'FISH', source: 'feed',
    firstSeenAt: AT, marketCap: 30_000, liquidity: 12_000, holders: 150, at: AT };
  const marketLead = lead({ address: '0x' + '3'.repeat(40) });
  let records = observeTracks([], [marketLead], AT);
  records = observeTracks(records, [], AT, { pools: [feedLead] });
  assert.equal(records.length, 2);

  // The feed only ever knows a pool while it is inside its own half-hour window,
  // so four hours later this is not a lead the board is still watching.
  const source = { retentionMs: 7 * 24 * 60 * 60_000, feedRetentionMs: 60 * 60_000 };
  records = observeTracks(records, [lead({ marketCap: 21_000 })], AT + 4 * 60 * 60_000, source);
  assert.deepEqual(records.map(row => row.source), ['market'],
    'the feed lead is gone; the market lead is still on the board');
});

test('a feed lead can never be kept longer than a market lead, whatever the caller asks', () => {
  const seen = { chain: 'bsc', address: EVM, symbol: 'FISH', source: 'feed',
    firstSeenAt: AT, marketCap: 30_000, liquidity: 12_000, holders: 150, at: AT };
  const records = observeTracks([], [], AT, { pools: [seen] });
  // A caller asking for a feed window wider than the board's own would be
  // hoarding under another name, so the shorter of the two wins.
  const kept = observeTracks(records, [], AT + 90 * 60_000,
    { retentionMs: 60 * 60_000, feedRetentionMs: 7 * 24 * 60 * 60_000 });
  assert.equal(kept.length, 0);
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

test('a lead the feeds stopped reporting is retired long before its week is up', () => {
  // The age ceiling is a week; a lead that dropped out of the hot list is over
  // in two hours. Without this, a pool down to a tenth of its price sits in
  // front of the reader for six more days, and the board ranks it first.
  const options = { retentionMs: 7 * 24 * 60 * 60_000, staleMs: 2 * 60 * 60_000 };
  const records = observeTracks([], [lead()], AT, options);

  const stillWarm = observeTracks(records, [], AT + 60 * 60_000, options);
  assert.equal(stillWarm.length, 1, 'one silent hour is a pause, not an ending');

  const gone = observeTracks(records, [], AT + 3 * 60 * 60_000, options);
  assert.equal(gone.length, 0, 'three silent hours is not a lead any more');
});

test('a lead that is still being reported keeps its anchor however old it is', () => {
  const options = { retentionMs: 7 * 24 * 60 * 60_000, staleMs: 2 * 60 * 60_000 };
  let records = observeTracks([], [lead()], AT, options);
  // Re-sighted on every cycle for a full day: old, but never silent.
  for (let hour = 1; hour <= 24; hour++) {
    records = observeTracks(records, [lead({ price: 0.0001 * (1 + hour / 100) })], AT + hour * 60 * 60_000, options);
  }
  assert.equal(records.length, 1, 'a pool the feed keeps listing is still a lead');
  assert.equal(records[0].firstSeenAt, AT, 'and it keeps the anchor it was found with');
  assert.equal(records[0].lastSeenAt, AT + 24 * 60 * 60_000);
});

test('a sighting after a long silence starts a new record, not a continuation', () => {
  // The board is not always watching: a chain can be switched off and switched
  // back on. Comparing today's price to an anchor from before a day-long gap
  // would read the gap as a market move, which this file refuses everywhere
  // else it appears.
  const options = { retentionMs: 7 * 24 * 60 * 60_000, staleMs: 2 * 60 * 60_000 };
  let records = observeTracks([], [lead()], AT, options);
  records = observeTracks(records, [lead({ price: 0.0002 })], AT + 60_000, options);
  assert.deepEqual(records[0].signals.map(s => s.id), ['price:2']);

  // A day later the same address comes back at a quarter of the old price.
  records = observeTracks(records, [lead({ price: 0.000025 })], AT + 24 * 60 * 60_000, options);
  assert.equal(records.length, 1);
  assert.equal(records[0].firstSeenAt, AT + 24 * 60 * 60_000, 'the anchor is the sighting that resumed, not the one before the gap');
  assert.equal(records[0].snapshot.price, 0.000025);
  assert.deepEqual(records[0].signals, [], 'and a rung crossed before a gap is not still crossed after it');
});

test('a nonsense silence window falls back to the shipped one', () => {
  const records = observeTracks([], [lead()], AT);
  assert.equal(observeTracks(records, [], AT + 3 * 60 * 60_000, { staleMs: 0 }).length, 0,
    'a zero window must not mean "never retire"');
  assert.equal(observeTracks(records, [], AT + 3 * 60 * 60_000, { staleMs: 'soon' }).length, 0);
});

test('a record with no readable timestamp is retired rather than kept forever', () => {
  const orphan = { chain: 'bsc', address: EVM, symbol: 'FISH', source: 'market', reached: {}, signals: [] };
  const records = observeTracks([orphan], [], AT, { retentionMs: 7 * 24 * 60 * 60_000 });
  assert.equal(records.length, 0);
});

// Wallet flow is the board's only exit-class evidence, and it is the one kind of
// evidence that cannot come from a market snapshot at all: "several proven
// wallets are selling" is a delta over a trade feed. The tests below pin the
// three properties that make it safe to show — it warns without a price move,
// it outlives the next buy, and it never invents a lead.
test('an exit cluster alone reads as distribution, before any axis has moved', () => {
  let records = observeTracks([], [lead()], AT);
  assert.equal(classifyTrack(records[0], AT), 'WATCH', 'nothing has happened yet');

  records = observeTracks(records, [lead()], AT + 1000, { flows: [cluster()] });
  assert.equal(records[0].exitedAt, AT);
  assert.equal(classifyTrack(records[0], AT + 1000), 'DISTRIBUTION',
    'the wallets leaving is the whole claim; waiting for the price to confirm it would miss the exit');
  assert.deepEqual(records[0].signals.map(signal => signal.id), ['flow:EXIT']);
  assert.equal(records[0].signals[0].axis, 'flow', 'a cluster is not a rung, so it never wears an axis name');
  assert.equal(records[0].signals[0].rung, 3, 'the wallet count is what the card leads with');
});

test('the exit warning outlives a later buy, then expires on its own', () => {
  let records = observeTracks([], [lead()], AT, { flows: [cluster()] });
  records = observeTracks(records, [lead()], AT + 60_000, { flows: [cluster({ kind: 'ENTRY', at: AT + 60_000, closes: 0 })] });

  assert.equal(records[0].flow.kind, 'ENTRY', 'a later buy is a real change of fact and replaces the latest event');
  assert.equal(records[0].exitedAt, AT, 'but it does not erase the exit that already happened');
  assert.equal(classifyTrack(records[0], AT + 120_000), 'DISTRIBUTION', 'so the warning is still lit a minute later');
  assert.ok(records[0].signals.some(signal => signal.id === 'flow:ENTRY'), 'and the buy is logged in its own right');

  assert.equal(classifyTrack(records[0], AT + EXIT_ALERT_MS + 1), 'WATCH',
    'the warning is not a life sentence for the lead');
});

test('a flow event never invents a lead', () => {
  const records = observeTracks([], [lead()], AT, { flows: [cluster({ address: '0x' + '9'.repeat(40) })] });
  assert.equal(records.length, 1, 'a wallet moving is not evidence that a pool was observed');
  assert.equal(records[0].flow, undefined);
});

test('an out-of-order flow event never walks the board backwards', () => {
  let records = observeTracks([], [lead()], AT, { flows: [cluster({ at: AT + 60_000, wallets: 5 })] });
  records = observeTracks(records, [lead()], AT + 61_000, { flows: [cluster({ at: AT, wallets: 2 })] });
  assert.equal(records[0].flow.wallets, 5, 'the newer event stands');
  assert.equal(records[0].signals.filter(signal => signal.id === 'flow:EXIT').length, 1, 'and it is announced once');
});

// The discovery feed sees pools the market hot list never carries, which is why
// it feeds the board at all. The two feeds disagree on liquidity by up to 5x on
// the same pool, so a record must belong to exactly one of them.
test('a discovery lead keeps its own anchor and never displaces a market baseline', () => {
  const pool = { source: 'feed', chain: 'bsc', address: EVM, symbol: 'FISH',
    firstSeenAt: AT - 5 * 60_000,
    baseline: { marketCap: 10_000, liquidity: 4_000, holders: 40 },
    marketCap: 12_000, liquidity: 5_000, holders: 55 };

  const records = observeTracks([], [], AT, { pools: [pool] });
  assert.equal(records.length, 1, 'a pool the discovery feed saw is a lead like any other');
  assert.equal(records[0].source, 'feed');
  assert.equal(records[0].firstSeenAt, AT - 5 * 60_000,
    "the anchor is the feed's own first sighting, not the moment a cycle picked it up");
  assert.equal(records[0].snapshot.marketCap, 10_000, 'and the frozen reading is the baseline');
  assert.equal(records[0].latest.marketCap, 12_000, 'while the newest reading is the latest');

  const fromMarket = observeTracks([], [lead()], AT);
  const afterPool = observeTracks(fromMarket, [], AT + 60_000, { pools: [pool] });
  assert.deepEqual(afterPool[0].latest, fromMarket[0].latest,
    'the discovery feed cannot advance a record the market feed created');

  const fromPool = observeTracks([], [], AT, { pools: [pool] });
  const afterMarket = observeTracks(fromPool, [lead()], AT + 60_000);
  assert.deepEqual(afterMarket[0].latest, fromPool[0].latest,
    'and the market feed cannot advance a discovery record - that would read as the gap between two rulers');
  assert.equal(afterMarket[0].source, 'feed');

  // A claimed earlier timestamp only counts when it arrives with the reading it
  // belongs to: stamping today's numbers with an older time would be a worse lie
  // than admitting the board only started watching now.
  const stamped = observeTracks([], [], AT, { pools: [{ ...pool, baseline: undefined }] });
  assert.equal(stamped[0].firstSeenAt, AT);
});

test('the wallet cluster attaches to a lead whoever supplied its market facts', () => {
  // A cluster is an event about wallets, not an axis about scale, so it is
  // matched by address alone. This is the case that matters most in production:
  // the pool came from the discovery feed and the wallets are what make it worth
  // looking at.
  const pool = { source: 'feed', chain: 'bsc', address: EVM, symbol: 'FISH', baseline: { marketCap: 10_000 },
    marketCap: 12_000, liquidity: 5_000, holders: 55 };
  const records = observeTracks([], [], AT, { pools: [pool], flows: [cluster()] });
  assert.equal(records[0].source, 'feed');
  assert.equal(records[0].flow.kind, 'EXIT');
  assert.equal(classifyTrack(records[0], AT), 'DISTRIBUTION');
});

test('the exit count is reported next to the quadrants and expires with the warning', () => {
  let records = observeTracks([], [lead()], AT);
  records = observeTracks(records, [lead()], AT + 1000, { flows: [cluster()] });

  const summary = summarizeTracking(records, AT + 2000);
  assert.equal(summary.exiting, 1);
  assert.equal(summary.quadrants.DISTRIBUTION, 1);
  assert.ok(summary.recentSignals.some(signal => signal.axis === 'flow' && signal.symbol === 'FISH'),
    'a cluster reaches the board-wide signal feed with its lead attached');

  assert.equal(summarizeTracking(records, AT + EXIT_ALERT_MS + 1).exiting, 0,
    'the count expires with the warning rather than staying lit forever');
});

// The verdict is formed where the risk facts live and only carried here. Two
// properties matter. It survives the fold, and an observation that arrives
// without one - which is every observation that has no verdict to give - does not
// clear it, because a cleared verdict reads as a pass.
//
// The fixture warns rather than vetoes: a veto is no longer tracked at all (see
// the test below), so a caution is the strongest verdict that can be observed
// surviving the fold.
test('a lead keeps its verdict, and a later sighting cannot clear it', () => {
  const pool = { chain: 'bsc', address: EVM, symbol: 'FISH', source: 'feed', firstSeenAt: AT,
    baseline: { marketCap: 20_000, liquidity: 10_000, holders: 100, at: AT },
    marketCap: 20_000, liquidity: 10_000, holders: 100, at: AT,
    veto: { state: 'CAUTION', reasons: [{ code: 'BUNDLER_HEAVY', level: 'CAUTION', value: 0.44 }],
      unassessed: ['HONEYPOT'], assessed: 16, coverage: 0.94 },
    firstVeto: { state: 'CLEAR', reasons: [], unassessed: ['HONEYPOT'], assessed: 16 },
    curve: { from: 0.04, to: 0.33, delta: 0.29, minutes: 4, perMinute: 0.0725, stage: 'MID' } };

  const fromFeed = observeTracks([], [], AT, { pools: [pool] });
  assert.equal(fromFeed[0].veto.state, 'CAUTION');
  assert.equal(fromFeed[0].firstVeto.state, 'CLEAR', 'the answer given at discovery is kept apart');
  assert.equal(fromFeed[0].curve.stage, 'MID');

  // The same feed, one cycle later, with a market reading and no verdict on it:
  // the provider answered the market question, not the risk one.
  const later = observeTracks(fromFeed, [], AT + 60_000, { pools: [{ chain: 'bsc', address: EVM, symbol: 'FISH',
    source: 'feed', firstSeenAt: AT, marketCap: 30_000, liquidity: 12_000, holders: 150, at: AT + 60_000 }] });
  assert.equal(later[0].veto.state, 'CAUTION', 'a sighting without a verdict must not read as a pass');
  assert.equal(later[0].firstVeto.state, 'CLEAR');
  assert.equal(later[0].curve.stage, 'MID', 'and the travel is not lost either');

  // Cleaned up on the way out: a lead that never had a verdict reports none,
  // rather than an empty object the page would have to guess at.
  const market = observeTracks([], [lead()], AT);
  assert.equal(market[0].veto, null);
  assert.equal(market[0].curve, null);
});

// A veto is not a caveat on a lead, it is the checklist refusing it - so the lead
// is not tracked at all. It never reaches the board, and one already on the board
// leaves the moment the verdict arrives. Measured before this rule: 22 of 84 live
// rows were vetoed, almost all of them CREATOR_SPRAY, and the board ranks a
// drained pool first, so the spray was the first thing on screen.
test('a vetoed lead is not tracked, and one already on the board is dropped', () => {
  const pool = (over = {}) => ({ chain: 'bsc', address: EVM, symbol: 'SPRAY', source: 'feed',
    firstSeenAt: AT, at: AT, marketCap: 20_000, liquidity: 10_000, holders: 100,
    veto: { state: 'BLOCK', reasons: [{ code: 'CREATOR_SPRAY', level: 'BLOCK', value: 288 }], assessed: 16 },
    ...over });

  const fresh = {};
  assert.deepEqual(observeTracks([], [], AT, { pools: [pool()], stats: fresh }), [],
    'a vetoed lead never reaches the board');
  assert.equal(fresh.vetoed, 1, 'and the refusal is reported rather than silent');

  // Clean when found, vetoed later: the verdict is a current fact, so the card
  // goes with it rather than staying as a warning about something already known.
  const clean = pool({ veto: { state: 'CLEAR', reasons: [], assessed: 16 } });
  const before = observeTracks([], [], AT, { pools: [clean] });
  assert.equal(before.length, 1, 'a cleared lead is tracked as normal');
  const after = {};
  assert.deepEqual(observeTracks(before, [], AT + 60_000, { pools: [pool({ at: AT + 60_000 })], stats: after }), [],
    'the veto removes a lead that was already on the board');
  assert.equal(after.vetoed, 1);

  // The rule is about a veto, not about a warning: a caution is a lead the reader
  // may still want to see, and dropping it would empty the board of the very
  // leads the checklist asked to look at twice.
  const cautioned = pool({ veto: { state: 'CAUTION', reasons: [{ code: 'DEV_HOLDS', level: 'CAUTION', value: 0.2 }], assessed: 16 } });
  assert.equal(observeTracks([], [], AT, { pools: [cautioned] }).length, 1,
    'only a veto refuses a lead; a caution still only warns');
});

test('the refused-lead count is reported even though the board no longer carries them', () => {
  const at = AT;
  const base = { chain: 'bsc', symbol: 'FISH', firstSeenAt: at, lastSeenAt: at,
    snapshot: { marketCap: 20_000, liquidity: 10_000, holders: 100, top10Rate: null, at },
    latest: { marketCap: 20_000, liquidity: 10_000, holders: 100, top10Rate: null, at },
    risk: null, reached: {}, signals: [] };
  // What the board actually holds now: a veto never gets this far.
  const rows = [
    { ...base, address: '0x' + '2'.repeat(40), veto: { state: 'CAUTION' } },
    { ...base, address: '0x' + '3'.repeat(40), veto: { state: 'CLEAR' } },
    { ...base, address: '0x' + '4'.repeat(40), veto: null }
  ];
  const summary = summarizeTracking(rows, at, { vetoed: 9 });
  assert.equal(summary.blocked, 9, 'the tally is handed in by the filter that dropped them');
  assert.equal(summary.tracked, 3, 'and it does not inflate the board it describes');
  assert.equal(summary.exiting, 0);

  // The two sources are disjoint by construction, so a caller holding rows that
  // were never filtered still gets its vetoes counted rather than a silent zero.
  const raw = summarizeTracking([...rows, { ...base, address: '0x' + '5'.repeat(40), veto: { state: 'BLOCK' } }], at);
  assert.equal(raw.blocked, 1, 'a veto left among the rows is counted, and not twice');
  assert.equal(raw.tracked, 4);
});
