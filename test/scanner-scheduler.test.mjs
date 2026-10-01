import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { Scanner, screeningSummary } from '../src/scanner.mjs';

// These cases exercise the shared AVE lane: how it rotates chains, defers the
// ones a provider cannot confirm, and forecasts turns. That mechanism has to
// hold for any chain pair, so the fixtures pin their own chain space instead of
// inheriting whichever chains the running build happens to enable. `robinhood`
// stays useful here because AVE reports it as undocumented, which is what the
// recovery-priority assertions need to observe.
const chainScopedConfig = Object.freeze({
  ...config,
  supportedChains: Object.freeze(['bsc', 'robinhood', 'eth', 'sol'])
});

function stateFixture({ activeChain, activeAttemptAt, otherChain, otherAttemptAt }) {
  const scope = attemptAt => ({
    candidates: [], rejected: [], auditQueue: [], outcomes: [], sourceHealth: {},
    lastAttemptAt: attemptAt
  });
  return {
    value: {
      activeChain,
      ...scope(activeAttemptAt),
      events: [], riskExclusions: {},
      chainStates: { [otherChain]: scope(otherAttemptAt) }
    },
    save(next = this.value) { this.value = structuredClone(next); }
  };
}

function schedulerProvider(recoveryActive, headOnly = recoveryActive) {
  return {
    nextAllowedAt: 0,
    snapshot: () => ({
      recovery: { active: recoveryActive, headOnly },
      chains: {
        bsc: { documented: true },
        robinhood: { documented: false }
      }
    })
  };
}

async function startOnce({ recoveryActive, headOnly = recoveryActive, activeChain, activeAttemptAt, otherChain, otherAttemptAt }) {
  const state = stateFixture({ activeChain, activeAttemptAt, otherChain, otherAttemptAt });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const scanner = new Scanner({
    provider: schedulerProvider(recoveryActive, headOnly),
    state,
    controls,
    settings: { ...chainScopedConfig, chain: activeChain, scanIntervalMs: 3_600_000 }
  });
  const visits = [];
  scanner.cycle = async () => { visits.push(scanner.activeChain); };
  await scanner.start();
  scanner.stop();
  return { scanner, visits };
}

test('Scanner.start prefers documented BSC during AVE recovery even when unverified Robinhood is least recently attempted', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: true,
    activeChain: 'robinhood',
    activeAttemptAt: 1,
    otherChain: 'bsc',
    otherAttemptAt: 999
  });
  assert.deepEqual(visits, ['bsc']);
  assert.equal(scanner.activeChain, 'bsc');
});

test('Scanner.start preserves least-recently-attempted rotation outside AVE recovery', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: false,
    activeChain: 'bsc',
    activeAttemptAt: 999,
    otherChain: 'robinhood',
    otherAttemptAt: 1
  });
  assert.deepEqual(visits, ['robinhood']);
  assert.equal(scanner.activeChain, 'robinhood');
});

test('Scanner.start keeps the documented BSC probe lane while recovery remains active even with a legacy false headOnly flag', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: true,
    headOnly: false,
    activeChain: 'bsc',
    activeAttemptAt: 999,
    otherChain: 'robinhood',
    otherAttemptAt: 1
  });
  assert.deepEqual(visits, ['bsc']);
  assert.equal(scanner.activeChain, 'bsc');
});

test('Scanner.start hydrates durable recovery before selecting the first chain after restart', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 999, otherChain: 'robinhood', otherAttemptAt: 1 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  let hydrated = false;
  const provider = schedulerProvider(false);
  provider.hydrate = async () => { hydrated = true; provider.snapshot = schedulerProvider(true).snapshot; };
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...chainScopedConfig, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  const visits = [];
  scanner.cycle = async () => { visits.push(scanner.activeChain); };
  await scanner.start(); scanner.stop();
  assert.equal(hydrated, true);
  assert.deepEqual(visits, ['bsc']);
});

test('Scanner.start wakes at an existing recovery deadline without adding another full scan interval', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const provider = schedulerProvider(true);
  provider.nextAllowedAt = Date.now() + 30_000;
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...chainScopedConfig, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = (_callback, delay) => { scheduled = delay; return 1; };
    globalThis.clearTimeout = () => {};
    await scanner.start(); scanner.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.ok(scheduled > 29_000 && scheduled <= 30_000, `unexpected recovery delay ${scheduled}`);
});

test('Scanner.start waits for the normal AVE transport lane without entering a false scanning state', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const provider = schedulerProvider(false);
  provider.schedulerReadyAt = Date.now() + 30_000;
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...chainScopedConfig, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  let cycles = 0;
  scanner.cycle = async () => { cycles++; };
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = (_callback, delay) => { scheduled = delay; return 1; };
    globalThis.clearTimeout = () => {};
    await scanner.start(); scanner.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(cycles, 0);
  assert.ok(scheduled > 29_000 && scheduled <= 30_000, `unexpected transport delay ${scheduled}`);
});

test('multi-chain view can only switch among chains enabled for scanning', () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const scanner = new Scanner({ provider: schedulerProvider(false), state, controls, settings: { ...chainScopedConfig, chain: 'bsc' } });

  assert.deepEqual(scanner.switchChain('robinhood'), {
    activeChain: 'robinhood', pendingChain: '', queued: false
  });
  assert.throws(() => scanner.switchChain('eth'), error =>
    error?.code === 'CHAIN_NOT_ENABLED' && error?.statusCode === 409);
  assert.equal(scanner.activeChain, 'bsc');
  assert.deepEqual(controls.value.enabledChains, ['bsc', 'robinhood']);
});

test('shared five-minute lane forecasts chain turns, not a five-minute promise for every chain', () => {
  const now = 1_900_000_000_000;
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 30, otherChain: 'eth', otherAttemptAt: 10 });
  state.value.chainStates.sol = { lastAttemptAt: 20 };
  const provider = schedulerProvider(false); provider.schedulerReadyAt = now + 300_000;
  const controls = { value: { enabledChains: ['bsc', 'eth', 'sol'] } };
  const scanner = new Scanner({ provider, state, controls, settings: { ...chainScopedConfig, scanIntervalMs: 300_000 } });
  const eth = scanner.scheduleSnapshot('eth', now), sol = scanner.scheduleSnapshot('sol', now), bsc = scanner.scheduleSnapshot('bsc', now);
  assert.equal(eth.sharedIntervalMs, 300_000); assert.equal(eth.nominalChainIntervalMs, 900_000);
  assert.equal(eth.selectedNextAttemptAt, now + 300_000);
  assert.equal(sol.selectedNextAttemptAt, now + 600_000);
  assert.equal(bsc.selectedNextAttemptAt, now + 900_000);
  assert.equal(eth.estimate, 'earliest'); assert.equal(eth.guaranteed, false);
  scanner.nextTickAt = now + 400_000;
  assert.equal(scanner.scheduleSnapshot('eth', now).selectedNextAttemptAt, now + 400_000);
});

test('forecast respects provider backoff and recovery scope without inventing deferred-chain dates', () => {
  const now = 1_900_000_000_000;
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 30, otherChain: 'robinhood', otherAttemptAt: 10 });
  const provider = schedulerProvider(true); provider.nextAllowedAt = now + 900_000;
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const scanner = new Scanner({ provider, state, controls, settings: chainScopedConfig });
  const ready = scanner.scheduleSnapshot('bsc', now), deferred = scanner.scheduleSnapshot('robinhood', now);
  assert.deepEqual(ready.eligibleChains, ['bsc']); assert.equal(ready.selectedNextAttemptAt, now + 900_000);
  assert.equal(ready.reason, 'backoff');
  assert.equal(deferred.selectedNextAttemptAt, null); assert.equal(deferred.estimate, 'unavailable');
  assert.equal(deferred.reason, 'recovery_chain_deferred');
  assert.equal(scanner.scheduleSnapshot('sol', now).reason, 'disabled');
  provider.snapshot = () => ({ manualResetRequired: true });
  assert.equal(scanner.scheduleSnapshot('bsc', now).nextSharedAttemptAt, null);
  assert.equal(scanner.scheduleSnapshot('bsc', now).reason, 'manual_reset_required');
});

test('in-flight, auth-blocked and stopped states make no precise selected-chain completion promise', () => {
  const now = 1_900_000_000_000;
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 30, otherChain: 'eth', otherAttemptAt: 10 });
  const provider = schedulerProvider(false), controls = { value: { enabledChains: ['bsc', 'eth'] } };
  const scanner = new Scanner({ provider, state, controls, settings: chainScopedConfig });
  scanner.running = true;
  assert.equal(scanner.scheduleSnapshot('bsc', now).estimate, 'in_progress');
  assert.equal(scanner.scheduleSnapshot('bsc', now).selectedNextAttemptAt, null);
  assert.equal(scanner.scheduleSnapshot('eth', now).selectedNextAttemptAt, now + 300_000);
  scanner.running = false; provider.disabled = true;
  assert.equal(scanner.scheduleSnapshot('bsc', now).reason, 'auth_required');
  assert.equal(scanner.scheduleSnapshot('bsc', now).selectedNextAttemptAt, null);
  provider.disabled = false; scanner.stop();
  assert.equal(scanner.scheduleSnapshot('bsc', now).reason, 'stopped');
});

test('disabled deep audit rejects a valid manual request without creating a phantom queue', () => {
  const now = Date.now(), state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 30, otherChain: 'eth', otherAttemptAt: 10 });
  const scanner = new Scanner({ provider: schedulerProvider(false), state, settings: { ...chainScopedConfig, maxDeepAuditsPerCycle: 0 } });
  const row = { address: '0x' + '1'.repeat(40), chain: 'bsc', marketProvider: 'AVE', market_cap: 40000, liquidity: 10000,
    price: 1, volume_5m: 1000, launch_at: Math.floor(now / 1000) - 900, capturedAt: now, sourceUpdatedAt: now, expiresAt: now + 30000 };
  assert.deepEqual(scanner.enqueueReview('bsc', row), { accepted: false, reason: 'deep_audit_disabled' });
  assert.equal(scanner.requestedReviews.size, 0);
});

test('market screening summary counts tokens once per reason category, not safety approvals', () => {
  const summary = screeningSummary([
    { screen: { pass: true, reasons: [] } },
    { screen: { pass: false, reasons: ['AVE 行情已过期或原始时间未核验', '市值原始时间待更新', '流动性数据未知'] } },
    { screen: { pass: false, reasons: ['市值不在发现范围', '检测到貔貅盘'] } }
  ], 123);
  assert.equal(summary.received, 3); assert.equal(summary.marketQualified, 1); assert.equal(summary.filtered, 2);
  assert.equal(summary.reasonCounts.stale, 1); assert.equal(summary.reasonCounts.missing_market, 1);
  assert.equal(summary.reasonCounts.market_cap, 1); assert.equal(summary.reasonCounts.known_risk, 1);
});

test('switching to an unscanned or legacy chain cannot inherit another chain screening counts', () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 30, otherChain: 'eth', otherAttemptAt: 10 });
  state.value.screening = { received: 100, checkedAt: 123 };
  const scanner = new Scanner({ provider: schedulerProvider(false), state, settings: chainScopedConfig });
  scanner.activateChain('eth', true);
  assert.equal(state.value.screening, null);
  scanner.activateChain('bsc', true);
  assert.equal(state.value.screening.received, 100);
  scanner.activateChain('sol', true);
  assert.equal(state.value.screening, null);
});
