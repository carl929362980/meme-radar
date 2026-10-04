import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GmgnDiscovery, CHAIN_PLANS, SIGNAL_KINDS, createGmgnDiscovery, pruneState } from '../src/gmgn-discovery.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The engine's whole job is timing, so the tests drive time explicitly rather
// than sleeping. The injected scheduler hands back a handle the test can fire,
// which makes a 90-second cadence instant and, more importantly, makes the
// assertions about *when* things happen exact instead of approximate.
function harness({ client, chains = ['sol'], minWallets, bufferMs = 30 * 60_000 } = {}) {
  let clock = 1_791_000_000_000;
  const timers = [];
  const engine = new GmgnDiscovery({
    client, chains, bufferMs,
    // Left undefined in most cases so the tests also cover the shipped default.
    ...(minWallets === undefined ? {} : { minWallets }),
    settings: { supportedChains: chains },
    now: () => clock,
    schedule: (fn, ms) => { const handle = { fn, ms, cancelled: false }; timers.push(handle); return handle; },
    cancel: (handle) => { handle.cancelled = true; }
  });
  return {
    engine, timers,
    at: () => clock,
    seconds: () => Math.floor(clock / 1000),
    advance(ms) { clock += ms; },
    async tick() {
      const handle = timers.shift();
      assert.ok(handle, 'expected an armed timer to fire');
      handle.fn();
      await flush(); await flush(); await flush();
      return handle;
    }
  };
}

function poolRow(overrides = {}) {
  return {
    provider: 'GMGN', chain: 'sol', address: 'PoolA1111111111111111111111111111111111111',
    symbol: 'POOLA', name: 'Pool A', marketCap: 5_000, liquidity: 8_000, holders: 12,
    progress: 0.2, createdAt: 1_790_999_000, launchpad: 'Pump.fun', ...overrides
  };
}

// A row shaped the way the provider actually answers: the coverage audit measured
// every field below at 100% on SOL, so a row without them is a fixture artefact
// rather than a realistic pool - and a verdict made from it would be UNKNOWN for
// the right reason (not enough was asked), which is not what these tests are
// about. `poolRow` stays sparse so the coverage tests can use it.
const richPool = (overrides = {}) => poolRow({
  creatorCreatedCount: 4, creatorTokenStatus: 'creator_hold',
  bundlerRate: 0.01, ratTraderRate: 0.01, insiderHoldRate: 0.01, sniperHoldRate: 0.01,
  devHoldRate: 0, top10Rate: 0.2, botDegenRate: 0.01, entrapmentRate: 0,
  buyTax: 0, sellTax: 0, rugRatio: 0.01, washTrading: false, renouncedMint: true, ...overrides
});

let makerSeed = 0;
function tradeRow(address, maker, side, at, overrides = {}) {
  return { provider: 'GMGN', chain: 'sol', kind: 'smartmoney', address, maker, side, at,
    amountUsd: 250, isClose: false, symbol: 'POOLA', ...overrides };
}

function fakeClient({ pools = [], trades = {}, enabled = true, cooling = false } = {}) {
  const state = { pools, trades, enabled, cooling, trenchesCalls: 0, tradeCalls: 0 };
  const client = {
    get enabled() { return state.enabled; },
    cooling: () => state.cooling,
    snapshot: () => ({ lastErrorCode: state.cooling ? 'RATE_LIMIT_BANNED' : '' }),
    trenches: async () => { state.trenchesCalls++; return state.pools; },
    trackTrades: async (kind) => { state.tradeCalls++; return state.trades[kind] ?? []; }
  };
  return { client, state };
}

test('the first sighting is frozen while later polls only advance the latest reading', async () => {
  let cap = 5_000, liq = 8_000;
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [poolRow({ marketCap: cap, liquidity: liq })];
  const h = harness({ client });
  h.engine.start();

  await h.tick();
  const first = h.engine.snapshot('sol');
  assert.equal(first.poolCount, 1);
  assert.equal(first.counts.newPool, 1);
  const announced = first.signals.find((signal) => signal.kind === 'NEW_POOL');
  assert.equal(announced.marketCap, 5_000);

  cap = 50_000; liq = 30_000;
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();

  const after = h.engine.snapshot('sol');
  // The pool is seen once, so it is announced once. A re-sighting is not news.
  assert.equal(after.counts.newPool, 1);
  assert.equal(after.signals.filter((signal) => signal.kind === 'NEW_POOL').length, 1);
  const pool = after.pools.find((entry) => entry.address === poolRow().address);
  assert.equal(pool.first.marketCap, 5_000, 'the anchor keeps the first reading');
  assert.equal(pool.latest.marketCap, 50_000, 'the latest reading moves');
});

test('a cluster of distinct wallets fires an entry signal', async () => {
  const address = 'MintB11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletOne', 'buy', 1_790_999_990),
    tradeRow(address, 'WalletTwo', 'buy', 1_790_999_995)
  ];
  const h = harness({ client, minWallets: 2 });
  h.engine.start();
  // `now` is 1_791_000_000_000ms = 1_791_000_000s, so these sit ten seconds back.
  await h.tick();

  const snapshot = h.engine.snapshot('sol');
  const entry = snapshot.signals.find((signal) => signal.kind === 'ENTRY');
  assert.ok(entry, 'two wallets buying together is an entry signal');
  assert.equal(entry.wallets, 2);
  assert.equal(entry.reason, 'CLUSTER_ENTRY');
  assert.equal(entry.activity, 'SMART');
  assert.equal(entry.marketCap, 5_000, 'the pool anchor is attached to the wallet evidence');
  assert.equal(snapshot.counts.entry, 1);
});

test('one wallet trading twice is one wallet, not a cluster', async () => {
  const address = 'MintC11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletSolo', 'buy', 1_790_999_980),
    tradeRow(address, 'WalletSolo', 'buy', 1_790_999_990)
  ];
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const snapshot = h.engine.snapshot('sol');
  assert.equal(snapshot.signals.filter((signal) => signal.kind === 'ENTRY').length, 0);
});

test('buy and sell never merge into one cluster', async () => {
  const address = 'MintD11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletBuy', 'buy', 1_790_999_990),
    tradeRow(address, 'WalletSell', 'sell', 1_790_999_990)
  ];
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const snapshot = h.engine.snapshot('sol');
  assert.equal(snapshot.signals.filter((signal) => signal.kind === 'ENTRY').length, 0);
  assert.equal(snapshot.signals.filter((signal) => signal.kind === 'EXIT').length, 0, 'one seller is not an exit cluster');
});

test('exits are treated as urgent one wallet earlier than entries', async () => {
  const address = 'MintE11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletExit1', 'sell', 1_790_999_980, { isClose: true }),
    tradeRow(address, 'WalletExit2', 'sell', 1_790_999_990, { isClose: true })
  ];
  // With a three-wallet bar for entries, two sellers must still get through.
  const h = harness({ client, minWallets: 3 });
  h.engine.start();
  await h.tick();

  const snapshot = h.engine.snapshot('sol');
  assert.equal(snapshot.signals.filter((signal) => signal.kind === 'ENTRY').length, 0);
  const exit = snapshot.signals.find((signal) => signal.kind === 'EXIT');
  assert.ok(exit, 'two full exits clear the lower exit bar');
  assert.equal(exit.reason, 'CLUSTER_EXIT_FULL');
  assert.equal(exit.closes, 2);
});

test('a partial exit is labelled differently from a full close', async () => {
  const address = 'MintF11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletPart1', 'sell', 1_790_999_980, { isClose: false }),
    tradeRow(address, 'WalletPart2', 'sell', 1_790_999_990, { isClose: false })
  ];
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const exit = h.engine.snapshot('sol').signals.find((signal) => signal.kind === 'EXIT');
  assert.equal(exit.reason, 'CLUSTER_EXIT_PART');
});

test('a cluster only speaks again when it grew or the cooldown elapsed', async () => {
  const address = 'MintG11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'Wallet1', 'buy', 1_790_999_990),
    tradeRow(address, 'Wallet2', 'buy', 1_790_999_991)
  ];
  const h = harness({ client, minWallets: 2 });
  h.engine.start();
  await h.tick();
  assert.equal(h.engine.snapshot('sol').counts.entry, 1);

  // Same two wallets, same window: repeating the announcement would be noise.
  h.advance(CHAIN_PLANS.sol.tradeMs + 1_000);
  await h.tick();
  assert.equal(h.engine.snapshot('sol').counts.entry, 1, 'an unchanged cluster stays quiet');

  // A third wallet joining is real escalation and must get through.
  state.trades.smartmoney.push(tradeRow(address, 'Wallet3', 'buy', h.seconds() - 5));
  h.advance(CHAIN_PLANS.sol.tradeMs + 1_000);
  await h.tick();
  assert.equal(h.engine.snapshot('sol').counts.entry, 2, 'growth re-announces');
  assert.equal(h.engine.snapshot('sol').signals.find((signal) => signal.kind === 'ENTRY').wallets, 3);
});

test('the trade buffer forgets rows older than its window', async () => {
  const address = 'MintH11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [tradeRow(address, 'WalletRecent', 'buy', 1_790_999_990)];
  const h = harness({ client, bufferMs: 120_000 });
  h.engine.start();
  await h.tick();
  assert.equal(h.engine.snapshot('sol').tradeCount, 1);

  h.advance(10 * 60_000);
  await h.tick();
  assert.equal(h.engine.snapshot('sol').tradeCount, 0, 'a ten-minute-old row is outside a two-minute window');
});

test('without a key the engine reports AUTH_REQUIRED instead of spending requests', async () => {
  const { client, state } = fakeClient({ enabled: false });
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const snapshot = h.engine.snapshot('sol');
  assert.equal(snapshot.status, 'AUTH_REQUIRED');
  assert.equal(snapshot.enabled, false);
  assert.equal(state.trenchesCalls, 0);
  assert.equal(state.tradeCalls, 0);
});

test('a cooling provider pauses the channel rather than being retried into', async () => {
  const { client, state } = fakeClient({ pools: [poolRow()], cooling: true });
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const snapshot = h.engine.snapshot('sol');
  assert.equal(snapshot.status, 'PAUSED');
  assert.equal(snapshot.code, 'RATE_LIMIT_BANNED');
  assert.equal(state.trenchesCalls, 0, 'a ban means no requests at all');
});

test('a rejecting provider cannot kill the loop', async () => {
  const client = {
    enabled: true, cooling: () => false, snapshot: () => ({ lastErrorCode: '' }),
    trenches: async () => { throw new Error('upstream exploded'); },
    trackTrades: async () => { throw new Error('upstream exploded'); }
  };
  const h = harness({ client });
  h.engine.start();
  await assert.doesNotReject(() => h.tick());
  // The loop must have rearmed itself after the failure.
  assert.equal(h.timers.length, 1, 'the next tick is still scheduled');
});

test('stopping the engine cancels the pending tick', async () => {
  const { client } = fakeClient({ pools: [poolRow()] });
  const h = harness({ client });
  h.engine.start();
  const armed = h.timers[0];
  h.engine.stop();
  assert.equal(armed.cancelled, true);
});

test('two chains are polled on their own cadence and kept separate', async () => {
  const { client } = fakeClient({ pools: [] });
  client.trenches = async (chain) => [poolRow({ chain, address: chain === 'sol' ? 'SolMint111111111111111111111111111111111111' : '0x00000000000000000000000000000000000000A1' })];
  const h = harness({ client, chains: ['sol', 'bsc'] });
  h.engine.start();
  await h.tick();
  assert.equal(h.engine.snapshot('sol').poolCount, 1);
  assert.equal(h.engine.snapshot('bsc').poolCount, 1);
});

test('the projected snapshot names no provider', async () => {
  const { client } = fakeClient({ pools: [poolRow()] });
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const serialized = JSON.stringify(h.engine.snapshot('sol'));
  assert.doesNotMatch(serialized, /gmgn/i);
  assert.equal(h.engine.snapshot('sol').execution, false);
});

test('the signal kinds are the documented three', () => {
  assert.deepEqual([...SIGNAL_KINDS], ['NEW_POOL', 'ENTRY', 'EXIT']);
});

test('the factory declines to build an engine with no key', () => {
  assert.equal(createGmgnDiscovery({ apiKey: '' }), null);
  const built = createGmgnDiscovery({ apiKey: 'test-key' });
  assert.ok(built instanceof GmgnDiscovery);
  assert.equal(built.enabled, true);
});

test('the shipped alert bar is the documented third wallet', async () => {
  const address = 'MintJ11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'DefaultOne', 'buy', 1_790_999_990),
    tradeRow(address, 'DefaultTwo', 'buy', 1_790_999_991)
  ];
  const h = harness({ client }); // no override: the engine's own default applies
  h.engine.start();
  await h.tick();
  assert.equal(h.engine.snapshot('sol').counts.entry, 0, 'two wallets is a watch, not the documented signal');
});

test('BSC uses a different bucket, and both chains carry a liquidity presence floor', () => {
  assert.deepEqual([...CHAIN_PLANS.bsc.types], ['near_completion']);
  assert.deepEqual([...CHAIN_PLANS.sol.types], ['new_creation']);
  assert.equal(CHAIN_PLANS.bsc.poolFilters.min_liquidity, 100);
  assert.equal(CHAIN_PLANS.sol.poolFilters.min_liquidity, 100);
});

test('BSC omits the rug gate because the chain does not answer it', () => {
  assert.equal(Object.hasOwn(CHAIN_PLANS.bsc.poolFilters, 'max_rug_ratio'), false);
  assert.equal(Object.hasOwn(CHAIN_PLANS.sol.poolFilters, 'max_rug_ratio'), true);
  assert.equal(Object.hasOwn(CHAIN_PLANS.sol.poolFilters, 'min_marketcap'), false, 'no value gate on discovery');
  assert.equal(Object.hasOwn(CHAIN_PLANS.bsc.poolFilters, 'min_marketcap'), false, 'no value gate on discovery');
});

// The tracking board's read side. This is the same state the panel renders,
// shaped for the board's vocabulary, and the shape is what the two guarantees
// below depend on: the feed hands over its *own* first sighting so a card's
// baseline is the moment the pool was truly first seen, and the market readings
// stay under this feed's name so the board never compares two rulers.
test('the board read hands over the feed\'s own anchor, not the cycle that picked it up', async () => {
  let cap = 5_000, liq = 8_000;
  const address = 'MintK11111111111111111111111111111111111111';
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [poolRow({ address, marketCap: cap, liquidity: liq })];
  const h = harness({ client });
  h.engine.start();
  await h.tick();

  cap = 40_000; liq = 30_000;
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();

  const read = h.engine.observations('sol');
  assert.equal(read.pools.length, 1);
  const pool = read.pools[0];
  assert.equal(pool.source, 'feed', 'the board needs to know which feed set this baseline');
  assert.equal(pool.address, address);
  assert.equal(pool.baseline.marketCap, 5_000, 'the baseline is the frozen first sighting');
  assert.equal(pool.marketCap, 40_000, 'and the reading is the newest one');
  assert.equal(pool.firstSeenAt, 1_791_000_000_000, 'with the moment the feed first saw it');
});

test('the board read carries the newest wallet event per address, and only inside the buffer', async () => {
  const address = 'MintL11111111111111111111111111111111111111';
  const other = 'MintM11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [poolRow({ address })] });
  state.trades.smartmoney = [
    tradeRow(address, 'WalletBuy1', 'buy', 1_790_999_990),
    tradeRow(address, 'WalletBuy2', 'buy', 1_790_999_991),
    tradeRow(address, 'WalletBuy3', 'buy', 1_790_999_992),
    tradeRow(other, 'WalletSell1', 'sell', 1_790_999_993, { isClose: true }),
    tradeRow(other, 'WalletSell2', 'sell', 1_790_999_994, { isClose: true })
  ];
  const h = harness({ client, minWallets: 3 });
  h.engine.start();
  await h.tick();

  const read = h.engine.observations('sol');
  const byAddress = new Map(read.flows.map((flow) => [flow.address, flow]));
  assert.equal(byAddress.get(address).kind, 'ENTRY');
  assert.equal(byAddress.get(address).wallets, 3);
  // The exit bar is one wallet below the entry bar, which is the whole reason a
  // two-wallet sell shows up here at all.
  assert.equal(byAddress.get(other).kind, 'EXIT');
  assert.equal(byAddress.get(other).wallets, 2);

  // Once the cluster falls out of the buffer the board hears nothing more about
  // it: a flow event is a statement about now, and a stale one must not be
  // presented as current.
  h.advance(31 * 60_000);
  await h.tick();
  assert.deepEqual(h.engine.observations('sol').flows, []);
});

test('the board read is empty for a chain the engine does not run, and starts nothing', () => {
  const h = harness({ client: fakeClient({}).client });
  assert.deepEqual(h.engine.observations('eth'), { pools: [], flows: [] });
  assert.equal(h.engine.states.size, 0, 'reading the board for an unsupported chain allocates nothing');
  assert.equal(h.engine.observations('sol').pools.length, 0, 'and a supported chain that has not polled yet is simply empty');
});

// main.mjs is a script, so nothing in the suite executes it and a wiring mistake
// there is invisible until the product is started for real. That is exactly how a
// temporal-dead-zone error shipped: the scanner was handed the engine on a line
// above the engine's own `const`. This runs the real wiring region against stubs,
// so the property under test is "the board's second source is connected", not
// "the file happens to contain the word feed".
test('the app hands the discovery engine to the tracking board as its second source', () => {
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const signals = createGmgnDiscovery(');
  const end = source.indexOf('\nconst liveDiscovery =', start);
  assert.ok(start > 0 && end > start, 'the wiring region moved; update this test rather than deleting it');

  const captured = {};
  const context = {
    config: { supportedChains: ['sol', 'bsc'], goplusLookupsPerCycle: 0 },
    market: {}, state: {}, controls: {}, sharedRequestIntervalMs: 1,
    SecondaryValidator: function () {}, GoPlusReader: function () {},
    createGmgnDiscovery: () => (captured.engine = { id: 'engine' }),
    Scanner: function (options) { captured.options = options; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.equal(captured.options.feed, captured.engine,
    'the object the scanner is handed must be the engine that was built, and built first');
});

// The pre-flight verdict. Two things are being pinned here: that "can this be
// entered" is answered from the newest facts rather than frozen beside the
// anchor, and that the answer given at discovery survives as its own claim.
test('a pool carries a verdict, which follows the facts, while the first verdict is kept', async () => {
  const address = 'MintV11111111111111111111111111111111111111';
  let created = 4;
  let status = 'creator_hold';
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [richPool({ address, creatorCreatedCount: created, creatorTokenStatus: status })];
  const h = harness({ client });
  h.engine.start();
  await h.tick();

  const found = h.engine.snapshot('sol').pools[0];
  assert.equal(found.veto.state, 'CLEAR');
  assert.equal(found.firstVeto.state, 'CLEAR');
  assert.deepEqual(found.veto.positives.map((row) => row.code), ['DEV_PRESENT'],
    'a creator still holding is the minority, so it is the thing worth reporting');
  assert.ok(found.veto.assessed >= 6, 'a clearance needs enough checks to mean something');
  assert.ok(found.veto.unassessed.includes('HONEYPOT'), 'and it must still say what it could not look at');

  // Between two polls the creator turns out to be a mint factory. A frozen
  // verdict would keep calling this pool clean, which is the exact failure a
  // safety layer must not have.
  created = 9_000;
  status = 'creator_close';
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();

  const later = h.engine.snapshot('sol').pools[0];
  assert.equal(later.veto.state, 'BLOCK');
  assert.equal(later.veto.reasons[0].code, 'CREATOR_SPRAY');
  assert.deepEqual(later.veto.positives, [], 'and the favourable mark is withdrawn along with the fact behind it');
  assert.ok(later.vetoAt > found.firstSeenAt, 'the current verdict is dated');
  // ...and the record of what was true at discovery is untouched, because
  // "clear then, vetoed now" is itself the most useful sentence on the card.
  assert.equal(later.firstVeto.state, 'CLEAR');
  assert.equal(found.firstVeto.state, 'CLEAR');
});

test('a refresh that says nothing does not erase what the provider already said', async () => {
  const address = 'MintY11111111111111111111111111111111111111';
  let creatorCount = 4;
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [richPool({ address, creatorCreatedCount: creatorCount })];
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  const before = h.engine.snapshot('sol').pools[0].veto;
  assert.ok(before.assessed >= 6);

  // A provider that omits a field has not discovered the field is empty. Calling
  // that "unassessed" would be tolerable; letting it read as "the risk went
  // away" would not. A dropped field would show up as one fewer assessed check.
  creatorCount = undefined;
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();
  assert.equal(h.engine.snapshot('sol').pools[0].veto.assessed, before.assessed,
    'the check still has its last real answer');

  // And the retention must not be mistaken for a refusal to update: a later
  // response that does answer with a bad value has to take effect.
  creatorCount = 9_000;
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();
  const replied = h.engine.snapshot('sol').pools[0].veto;
  assert.equal(replied.state, 'BLOCK');
  assert.equal(replied.reasons.find((reason) => reason.code === 'CREATOR_SPRAY').value, 9_000);
});

test('the curve is reported as travel rather than as a position', async () => {
  const address = 'MintW11111111111111111111111111111111111111';
  let progress = 0.04;
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [poolRow({ address, progress })];
  const h = harness({ client });
  h.engine.start();
  await h.tick();

  const start = h.engine.snapshot('sol').pools[0].curve;
  assert.equal(start.stage, 'EARLY');
  assert.equal(start.minutes, 0);
  assert.equal(start.perMinute, null, 'a pool that has not travelled has no rate, and inventing one would be a lie');

  progress = 0.33;
  h.advance(4 * 60_000);
  await h.tick();

  const moved = h.engine.snapshot('sol').pools[0].curve;
  assert.equal(moved.from, 0.04, 'the travel starts at the frozen sighting, not at the last poll');
  assert.equal(moved.to, 0.33);
  assert.equal(moved.minutes, 4);
  assert.equal(moved.perMinute, 0.0725);
  assert.equal(moved.stage, 'MID');
});

test('a cluster verdict uses the one fact only the trade buffer holds', async () => {
  const address = 'MintX11111111111111111111111111111111111111';
  const { client, state } = fakeClient({ pools: [richPool({ address })] });
  const makers = Array.from({ length: 8 }, (unused, index) => 'Wallet' + index);
  state.trades.smartmoney = makers.map((maker, index) => tradeRow(address, maker, 'buy', 1_790_999_990 + index));
  const h = harness({ client, minWallets: 3 });
  h.engine.start();
  await h.tick();

  const signal = h.engine.snapshot('sol').signals.find((row) => row.kind === 'ENTRY');
  assert.ok(signal, 'eight wallets buying is a cluster');
  // A market snapshot cannot express "nothing but buys has happened here" - that
  // is a property of the trades, and it is why the verdict is re-made here.
  assert.deepEqual(signal.veto.reasons.map((reason) => reason.code), ['ONE_SIDED_FLOW']);
  assert.equal(signal.veto.reasons[0].value.side, 'buy');
  assert.equal(signal.veto.state, 'CAUTION');
  assert.equal(signal.firstVeto.state, 'CLEAR', 'the pool was clean when it was first seen');

  // Where the pool was never sighted the verdict is absent, not favourable.
  const orphan = h.engine.snapshot('sol');
  assert.equal(orphan.pools.length, 1);
});

// A radar is bought to run for weeks, so what it remembers has to be bounded by
// time rather than by luck. The pool map is the one structure on the feed that
// used to grow with the market: one entry per pool ever seen, roughly 100k a day
// across the two chains, handed to the tracking board on every fold forever.
test('what is no longer observed is retired, and an unplaceable row is not kept out of caution', () => {
  const at = 1_791_000_000_000;
  const state = {
    pools: new Map([
      ['still-seen', { latest: { at: at - 20 * 60_000 } }],
      ['long-gone', { latest: { at: at - 40 * 60_000 } }],
      ['undated', { latest: {} }]
    ]),
    announced: new Map([
      ['a:ENTRY', { at: at - 10 * 60_000 }],
      ['b:ENTRY', { at: at - 20 * 60_000 }],
      ['c:ENTRY', { at: Number.NaN }]
    ])
  };
  pruneState(state, at, 30 * 60_000);
  assert.deepEqual([...state.pools.keys()], ['still-seen'], 'a pool still inside the buffer window stays');
  assert.deepEqual([...state.announced.keys()], ['a:ENTRY'], 'an announcement past its cooldown is forgotten');
});

test('retention never shortens below the window a pool can still anchor a cluster with', () => {
  const at = 1_791_000_000_000;
  const state = { pools: new Map([['seen', { latest: { at: at - 25 * 60_000 } }]]), announced: new Map() };
  // A caller asking for a two-minute buffer must not have retention follow it
  // down, or a pool would be evicted between two polls while it is still live.
  pruneState(state, at, 2 * 60_000);
  assert.deepEqual([...state.pools.keys()], ['seen']);
});

test('malformed state is left alone rather than throwing', () => {
  assert.equal(pruneState(null, 0), null);
  const state = { pools: new Map(), announced: new Map() };
  assert.equal(pruneState(state, 0), state);
  assert.doesNotThrow(() => pruneState({}, 0), 'a state without the two maps is not this function\'s problem');
});

test('a pool the feed has stopped seeing is dropped instead of accumulating forever', async () => {
  const first = richPool({ address: 'PoolA1111111111111111111111111111111111111', symbol: 'OLD' });
  const next = richPool({ address: 'PoolB1111111111111111111111111111111111111', symbol: 'NEW' });
  const { client, state } = fakeClient({ pools: [first] });
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  assert.deepEqual(h.engine.snapshot('sol').pools.map((row) => row.address), [first.address]);

  state.pools = [next];
  h.advance(31 * 60_000);
  await h.tick();
  assert.deepEqual(h.engine.snapshot('sol').pools.map((row) => row.address), [next.address],
    'the pool whose trades the buffer has forgotten is gone, and only the live one is left');
  assert.equal(h.engine.snapshot('sol').poolCount, 1);
});

test('the price fill gives a lead its price axis from the same provider, capped and never inside the gap', async () => {
  // The trenches feed answers no price - measured across 1279 live rows - so
  // without this fill a feed lead's price axis is dead forever. The fill is a
  // cadence, not a hope: a cap per poll, a gap between re-reads, and a failed
  // read that leaves the last real price in place.
  const reads = [];
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => [poolRow()];
  client.tokenInfo = async (chain, address) => {
    reads.push(`${chain}:${address}`);
    return { provider: 'GMGN', price: 0.00042, liquidity: 9_000, holders: 44,
      volume1h: 120, smartWallets: 1, renownedWallets: 0 };
  };
  const h = harness({ client });
  h.engine.start();
  await h.tick();

  const priced = h.engine.snapshot('sol').pools.find((entry) => entry.address === poolRow().address);
  assert.equal(priced.latest.price, 0.00042, 'the fill writes the price it read');
  assert.equal(h.engine.snapshot('sol').priceReads, 1);
  const board = h.engine.observations('sol').pools[0];
  assert.equal(board.price, 0.00042, 'the board read carries the price');
  assert.equal(board.baseline.price ?? null, null, 'the frozen anchor keeps the feed\'s own (missing) price');

  // Within the gap a re-poll must not spend a read, even though the pool poll
  // itself ran again.
  h.advance(CHAIN_PLANS.sol.poolMs + 1_000);
  await h.tick();
  assert.equal(reads.length, 1, 'a pool inside the enrichment gap is not re-read');
  // 🚨 Regression pin: the re-poll rebuilds the reading from the feed row,
  // which answers no price - the rebuild must carry the enriched price
  // forward, or the axis is null at almost every fold.
  assert.equal(h.engine.snapshot('sol').pools.find((entry) => entry.address === poolRow().address).latest.price, 0.00042,
    'a feed re-sighting keeps the price the fill wrote');

  // Past the gap the same pool is read again - a price axis that never moves
  // would read a stall as a market fact.
  h.advance(5 * 60_000);
  await h.tick();
  assert.equal(reads.length, 2, 'past the gap the price is read again');
});

test('the price fill is capped per poll, skips nothing honest, and survives a failed read', async () => {
  // More candidates than the cap: only the newest leads get budget this round.
  const addresses = Array.from({ length: 8 }, (_, i) => `Pool${i}111111111111111111111111111111111111`);
  const { client } = fakeClient({ pools: [] });
  client.trenches = async () => addresses.map((address, i) => poolRow({ address, symbol: `P${i}` }));
  const reads = [];
  client.tokenInfo = async (chain, address) => { reads.push(address); return { provider: 'GMGN', price: 0.001, liquidity: 1, holders: 1, volume1h: 1, smartWallets: 0, renownedWallets: 0 }; };
  const h = harness({ client });
  h.engine.start();
  await h.tick();
  assert.ok(reads.length <= 6, `expected the per-poll cap to hold, saw ${reads.length}`);

  // A failed read is skipped, not fatal, and does not erase anything.
  client.tokenInfo = async () => null;
  h.advance(5 * 60_000);
  await h.tick();
  const after = h.engine.snapshot('sol');
  assert.ok(after.poolCount >= 6, 'the pools are still there');
  assert.ok(after.pools.every((pool) => pool.latest.marketCap !== undefined), 'a failed fill touched nothing');
});
