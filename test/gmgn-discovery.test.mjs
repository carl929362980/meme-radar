import test from 'node:test';
import assert from 'node:assert/strict';
import { GmgnDiscovery, CHAIN_PLANS, SIGNAL_KINDS, createGmgnDiscovery } from '../src/gmgn-discovery.mjs';

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
