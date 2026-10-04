import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { collectOutcomeSamples, dueOutcomeJobs, selectOutcomeJobs, horizons, sampleBoarded } from '../src/outcomes.mjs';
import { Scanner, updateOutcomeTracking, upsertOutcome } from '../src/scanner.mjs';

const AT = 1800000000000;
const ca = n => '0x' + n.toString(16).padStart(40, '0');
// Baselines are named for the provider that priced them, and the read-back only
// ever answers for that name - so the fixtures name GMGN, the source the
// machine now measures with.
function history(changes = {}) {
  return { address: ca(1), chain: 'bsc', baselineProvider: 'GMGN', baselineAt: AT - 1900000,
    baselinePrice: 1, initialDecision: 'X_REVIEW', samples: {}, ...changes };
}
function memoryState(outcomes = []) {
  return { value: { activeChain: 'bsc', candidates: [], auditQueue: [], outcomes, events: [], riskExclusions: {}, chainStates: {}, sourceHealth: {} },
    save(next = this.value) { this.value = structuredClone(next); } };
}
function provider(changes = {}) {
  return { keyEpoch: 0, configured: async () => true, discover: async () => [], metrics: {},
    lastDiscoveryHealth: { complete: true, checkedAt: AT }, ...changes };
}

test('the default scan caps read-backs instead of draining a backlog, and preserves records', async t => {
  t.mock.method(Date, 'now', () => AT);
  // A ceiling, not a target: one kline read is weight 2 against a discovery poll
  // that costs about ten, so the backlog is worked a couple of rows per scan and
  // measurement can never crowd out discovery. Zero would be cheaper still and
  // would also mean the outcome table is never filled at all.
  assert.ok(config.outcomeReadsPerCycle > 0 && config.outcomeReadsPerCycle <= 12);
  const records = Array.from({ length: 100 }, (_, i) => history({ address: ca(i + 1) }));
  const state = memoryState(records);
  state.value.chainStates.eth = { outcomes: [history({ chain: 'eth' })] };
  let reads = 0;
  const scanner = new Scanner({ provider: provider({ priceAt: async () => { reads++; return null; } }), state, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); scanner.stop();
  assert.equal(reads, config.outcomeReadsPerCycle);
  // The backlog itself is untouched: a cap on spending is not a purge of history.
  assert.equal(state.value.outcomes.length, 100);
  assert.equal(state.value.chainStates.eth.outcomes.length, 1);
  assert.deepEqual(state.value.outcomes[0].samples, {});
});

test('opt-in paid backfill only selects enabled chains and matching baseline providers', () => {
  const scopes = { bsc: [history({ baselineProvider: undefined }), history({ address: ca(2) }), history({ chain: 'eth' })], eth: [history({ chain: 'eth' })] };
  const jobs = selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: 'GMGN', limit: 4, now: AT });
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every(job => job.chain === 'bsc' && job.row.address === ca(2)));
  assert.deepEqual(selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: 'GMGN', limit: 0, now: AT }), []);
  // A named provider only answers for its own baselines: an AVE row is left for
  // AVE, and an unnamed one is left alone rather than adopted.
  assert.deepEqual(selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: 'AVE', limit: 4, now: AT }), []);
  assert.deepEqual(selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: '', limit: 4, now: AT }), []);
});

test('failed historical windows stop after three attempts without fabricated prices', async () => {
  const rows = [history()]; let now = AT, calls = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    await collectOutcomeSamples(rows, { priceAt: async () => { calls++; return null; } }, 'bsc', { onlyKey: 'm5', now: () => now });
    now += 3600000;
  }
  assert.equal(calls, 3);
  assert.equal(rows[0].sampleRetries.m5.attempts, 3);
  assert.equal(rows[0].samples.m5, undefined);
  assert.ok(!dueOutcomeJobs(rows, now).some(job => job.key === 'm5'));
});

test('expired missed windows are not repeatedly purchased, and exact selected window is respected', async () => {
  const rows = [history()]; const calls = [];
  await collectOutcomeSamples(rows, { priceAt: async (_, at) => { calls.push(at); return { at, price: 2 }; } }, 'bsc', { limit: 1, onlyKey: 'm30', now: () => AT });
  assert.deepEqual(calls, [rows[0].baselineAt + horizons.m30]);
  assert.equal(rows[0].samples.m5, undefined);
  assert.equal(rows[0].samples.m30.return, 1);
  assert.deepEqual(dueOutcomeJobs([history({ baselineAt: AT - 3 * 86400000 })], AT), []);
});

test('budget, rate and credential pauses stop the batch without consuming retry attempts', async () => {
  for (const code of ['AVE_DISCOVERY_RESERVE', 'AVE_BUDGET', 'AVE_QUOTA', 'AVE_RATE_LIMITED', 'AVE_CHANGED']) {
    const rows = [history()]; let calls = 0;
    await collectOutcomeSamples(rows, { priceAt: async () => { calls++; throw Object.assign(new Error('mock'), { code, retryAt: AT + 999999 }); } }, 'bsc', { now: () => AT });
    assert.equal(calls, 1); assert.equal(rows[0].sampleRetries.m5.attempts, 0);
    assert.equal(rows[0].sampleRetries.m5.nextAt, AT + 999999);
  }
});

test('cancelled paid sampling forwards the signal and never records a late result', async () => {
  const controller = new AbortController(), rows = [history()]; let calls = 0;
  await collectOutcomeSamples(rows, { priceAt: async (_, at, chain, options) => {
    assert.equal(options.signal, controller.signal); calls++; controller.abort(); return { at, price: 2 };
  } }, 'bsc', { now: () => AT, signal: controller.signal });
  assert.equal(calls, 1); assert.deepEqual(rows[0].samples, {}); assert.equal(rows[0].sampleRetries, undefined);
});

test('the boarded sampling frame measures every card the board printed', () => {
  const board = [
    { chain: 'bsc', address: ca(1), symbol: 'ONE', source: 'feed', firstSeenAt: AT - 600_000,
      snapshot: { at: AT - 600_000, price: 1 } },
    { chain: 'bsc', address: ca(2), symbol: 'TWO', source: 'feed', firstSeenAt: AT - 600_000,
      snapshot: { at: AT - 600_000, price: 2 } },
    // No baseline price: the board shows "—" for this axis, and there is no
    // measurement to make. Skipped, not zeroed.
    { chain: 'bsc', address: ca(3), symbol: 'THREE', source: 'feed', firstSeenAt: AT - 600_000,
      snapshot: { at: AT - 600_000, price: null } }
  ];
  const outcomes = [];
  const report = sampleBoarded(outcomes, board, AT, { providers: { feed: 'GMGN' } });
  assert.equal(report.created, 2);
  assert.equal(report.boarded, 3);
  // The one it could not take is reported, and handed back by address so the
  // caller can go and get the missing reading instead of waiting for a rotation.
  // A `continue` with no count is how "the table is empty" hides.
  assert.equal(report.noPrice, 1);
  assert.deepEqual(report.awaiting, [ca(3)]);
  assert.equal(report.unnamed, 0);
  assert.equal(outcomes.length, 2);
  // The cohort key the coverage table already counts, so these rows land in
  // `passed` instead of sitting in a cohort nobody reads.
  assert.ok(outcomes.every(row => row.initialDecision === 'X_REVIEW'));
  assert.equal(outcomes[0].baselineProvider, 'GMGN');
  assert.equal(outcomes[0].baselinePrice, 1);
  assert.equal(outcomes[0].baselineAt, AT - 600_000);
  // Idempotent: a second pass over the same board adds nothing, and does not
  // re-stamp an existing baseline.
  const second = sampleBoarded(outcomes, board, AT, { providers: { feed: 'GMGN' } });
  assert.equal(second.created, 0);
  assert.equal(outcomes.length, 2);
});

test('a boarded row whose price came from a source nobody named is not measured', () => {
  // A source left out of `providers` has no ruler to be measured with, so it
  // produces no baseline rather than an unmeasurable one.
  const board = [{ chain: 'sol', address: '7U62Lm4CKa25eRdBdYv3QeTJjJirxTVGJpA3ePkkpump', symbol: 'X',
    source: 'feed', firstSeenAt: AT, snapshot: { at: AT, price: 1 } }];
  const outcomes = [];
  const unnamedReport = sampleBoarded(outcomes, board, AT, { providers: {} });
  assert.equal(unnamedReport.created, 0);
  assert.equal(unnamedReport.unnamed, 1, 'no ruler named means no baseline, and it says so');
  assert.equal(outcomes.length, 0);
  // An address this build cannot normalise is never keyed loosely.
  assert.deepEqual(sampleBoarded(outcomes, [{ chain: 'bsc', address: 'nope', source: 'feed',
    firstSeenAt: AT, snapshot: { at: AT, price: 1 } }], AT, { providers: { feed: 'GMGN' } }),
  { created: 0, boarded: 0, noPrice: 0, unnamed: 0, awaiting: [] });
  // And the frame is bounded, so a board that grows cannot grow the state file
  // without limit.
  const many = Array.from({ length: 10 }, (_, i) => ({ chain: 'bsc', address: ca(i + 1), source: 'feed',
    firstSeenAt: AT, snapshot: { at: AT, price: 1 } }));
  const capped = sampleBoarded([], many, AT, { providers: { feed: 'GMGN' }, limit: 4 });
  assert.equal(capped.created, 4);
  assert.equal(capped.boarded, 10);
});

test('passive observations remain free but never mix legacy and AVE baselines', () => {
  const row = { chain: 'bsc', address: ca(1), marketProvider: 'AVE', price: 2,
    capturedAt: AT, sourceUpdatedAt: AT, expiresAt: AT + 30000, stale: false };
  const older = history({ baselineAt: AT - horizons.m5, baselineProvider: undefined });
  assert.deepEqual(updateOutcomeTracking([older], new Map([[ca(1), row]]), AT, config.outcomeRetentionMs)[0].samples, {});
  const matched = { ...older, baselineProvider: 'AVE' };
  assert.equal(updateOutcomeTracking([matched], new Map([[ca(1), row]]), AT, config.outcomeRetentionMs)[0].samples.m5.return, 1);
  const created = [];
  upsertOutcome(created, { ...row, symbol: 'MOCK', status: 'X_REVIEW' }, AT);
  assert.equal(created[0].baselineProvider, 'AVE');
});

test('unknown and explicitly legacy baselines retain history without paid or passive backfills', async () => {
  // Two baselines with no ruler named on them: one written before provenance was
  // recorded, one explicitly marked. Neither may acquire a price from whichever
  // provider happens to be connected - an unlabelled curve is unmeasurable, not
  // free to adopt.
  const legacy = [undefined, 'LEGACY_UNKNOWN'].map((baselineProvider, index) => history({
    address: ca(index + 1), baselineProvider, baselineAt: AT - horizons.m30 - 60_000,
    samples: { m5: { at: AT - horizons.m30, price: 1.5, return: .5, source: 'LEGACY_SNAPSHOT' } }
  }));
  const before = structuredClone(legacy);
  const quotes = new Map(legacy.map(item => [item.address, { chain: 'bsc', address: item.address,
    marketProvider: 'GMGN', price: 2, capturedAt: AT, sourceUpdatedAt: AT, expiresAt: AT + 30_000, stale: false }]));
  assert.deepEqual(updateOutcomeTracking(legacy, quotes, AT, config.outcomeRetentionMs), before);
  let reads = 0;
  await collectOutcomeSamples(legacy, { priceAt: async () => { reads++; return { at: AT, price: 2 }; } }, 'bsc', { now: () => AT });
  assert.equal(reads, 0);
  assert.deepEqual(legacy, before);
  assert.deepEqual(selectOutcomeJobs({ bsc: legacy }, { enabledChains: ['bsc'], limit: 4, now: AT }), []);
});

test('a named baseline is read back by the provider that priced it and nobody else', async () => {
  const rows = [history({ baselineAt: AT - horizons.m30 - 60_000 })];
  const read = async (providerName) => {
    const fresh = structuredClone(rows);
    let reads = 0;
    await collectOutcomeSamples(fresh, { priceAt: async () => { reads++; return { at: AT, price: 2 }; } }, 'bsc',
      { now: () => AT, providerName });
    return reads;
  };
  assert.ok(await read('GMGN') > 0, 'the provider that set the baseline answers for it');
  assert.equal(await read('AVE'), 0, 'a different provider does not');
  // Same rule one layer up: job selection follows the row's own name.
  assert.equal(selectOutcomeJobs({ bsc: rows }, { enabledChains: ['bsc'], provider: 'GMGN', limit: 4, now: AT }).length > 0, true);
  assert.deepEqual(selectOutcomeJobs({ bsc: rows }, { enabledChains: ['bsc'], provider: 'AVE', limit: 4, now: AT }), []);
});

test('unlabelled outcome creation marks unknown provenance instead of asserting AVE', () => {
  const outcomes = [];
  upsertOutcome(outcomes, { chain: 'bsc', address: ca(1), price: 1, status: 'X_REVIEW' }, AT);
  assert.equal(outcomes[0].baselineProvider, 'LEGACY_UNKNOWN');
});

test('cache-only cycles preserve the upstream success clock', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const state = memoryState(), market = provider();
  const scanner = new Scanner({ provider: market, state, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); assert.equal(state.value.lastSuccessAt, AT);
  now += 120000; await scanner.cycle(); assert.equal(state.value.lastSuccessAt, AT);
  assert.equal(state.value.lastAttemptAt, now);
  market.lastDiscoveryHealth.checkedAt = now;
  await scanner.cycle(); assert.equal(state.value.lastSuccessAt, now); scanner.stop();
});

test('scanner rechecks enabled chains between historical requests', async t => {
  t.mock.method(Date, 'now', () => AT);
  const samples = Object.fromEntries(Object.keys(horizons).filter(key => key !== 'm5').map(key => [key, { price: 1, return: 0 }]));
  const state = memoryState([history({ samples: structuredClone(samples), baselineAt: AT - 2000000 })]);
  state.value.chainStates.eth = { outcomes: [history({ chain: 'eth', samples: structuredClone(samples) })] };
  const controls = { value: { enabledChains: ['bsc', 'eth'], annotations: {} } }, calls = [];
  const market = provider({ priceAt: async (_, at, chain) => { calls.push(chain); controls.value.enabledChains = ['bsc']; return { at, price: 2 }; } });
  const scanner = new Scanner({ provider: market, state, controls, settings: { ...config, chain: 'bsc', outcomeReadsPerCycle: 4 } });
  await scanner.cycle(); scanner.stop(); assert.deepEqual(calls, ['bsc']);
});
