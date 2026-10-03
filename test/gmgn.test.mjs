// The GMGN client exists so the pipeline can reach the one source that shows
// pools at five seconds old, without a process spawn per poll and without ever
// holding a signing key. These tests pin the properties that make it safe to put
// on a schedule: it cannot throw, it refuses to spend requests while cooling
// after a ban, a server-side filter change cannot silently widen the request, and
// a field the provider does not answer stays null rather than becoming a zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GmgnClient, buildTrenchesBody, loadApiKey, normalizeTrenchesRow, unwrap, gmgnBareAddress,
  gmgnDuration, TRENCHES_PLATFORMS, TRENCHES_QUOTE_ADDRESS_TYPES
} from '../src/gmgn.mjs';

function jsonResponse(body, status = 200, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => map.get(String(name).toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function ok(data) {
  return jsonResponse({ code: 0, data });
}

const SOL_MINT = '8HQgEcbhR5Xoh735zvndAocCLd7wdAYJfWHV55J8pump';

function trenchesRow(overrides = {}) {
  return {
    address: SOL_MINT, symbol: 'boocat', name: 'boocat',
    price: '0.0000029', market_cap: '2088.6', liquidity: '902.43', holder_count: 2,
    created_timestamp: 1_791_004_004, open_timestamp: 0,
    top_10_holder_rate: 0.3417, rug_ratio: 0, is_wash_trading: '0',
    rat_trader_amount_rate: '0.02', bundler_trader_amount_rate: '0.03',
    entrapment_ratio: 0, bot_degen_rate: 0.01, fresh_wallet_rate: 0.5,
    dev_team_hold_rate: 0, top70_sniper_hold_rate: 0, suspected_insider_hold_rate: 0,
    private_vault_hold_rate: 0, creator_balance_rate: 0, creator_created_count: 3,
    renounced_mint: '1', renounced_freeze_account: '1', burn_status: 'burn',
    buy_tax: '0', sell_tax: '0', progress: '0.1578',
    launchpad: 'ray_launchpad', launchpad_status: 0, pool_address: 'pool1', exchange: 'ray_launchpad',
    volume_24h: '12345', swaps_24h: 40, buys_24h: 21, sells_24h: 19, net_buy_24h: '500',
    smart_degen_count: 0, renowned_count: 0, bot_degen_count: 1,
    twitter: 'patchsol/status/1', website: 'https://example.test', telegram: '',
    ...overrides
  };
}

test('unwrap peels nested envelopes and leaves a plain payload alone', () => {
  assert.deepEqual(unwrap({ code: 0, data: { code: 0, data: { a: 1 } } }), { a: 1 });
  assert.deepEqual(unwrap({ new_creation: [] }), { new_creation: [] });
  assert.equal(unwrap('nope'), 'nope');
});

test('trenches body carries the allow-lists, because an empty array filters everything out', () => {
  const body = buildTrenchesBody({ chain: 'sol', types: ['new_creation'] });
  assert.deepEqual(Object.keys(body).sort(), ['new_creation', 'version']);
  assert.equal(body.version, 'v2');
  assert.deepEqual(body.new_creation.launchpad_platform, [...TRENCHES_PLATFORMS.sol]);
  assert.deepEqual(body.new_creation.quote_address_type, [...TRENCHES_QUOTE_ADDRESS_TYPES.sol]);
  assert.deepEqual(body.new_creation.filters, ['offchain', 'onchain']);
});

test('an unknown chain omits the allow-lists so the API applies its own default', () => {
  const body = buildTrenchesBody({ chain: 'nope', types: ['new_creation'] });
  assert.equal('launchpad_platform' in body.new_creation, false);
  assert.equal('quote_address_type' in body.new_creation, false);
});

test('server-side filters are merged into every requested category', () => {
  const body = buildTrenchesBody({
    chain: 'bsc', types: ['new_creation', 'completed'],
    filters: { min_marketcap: 10_000, max_created: 3_600 }
  });
  for (const type of ['new_creation', 'completed']) {
    assert.equal(body[type].min_marketcap, 10_000);
    assert.equal(body[type].max_created, '3600s');
  }
});

// A number here is rejected by the API with HTTP 200 + code -1 + empty buckets,
// which is indistinguishable from "the source found nothing". These tests exist
// so that mistake cannot come back.
test('duration filters are sent as strings with a unit, never as bare numbers', () => {
  const body = buildTrenchesBody({
    chain: 'sol', types: ['new_creation'],
    filters: { min_created: 300, max_created: 3_600 }
  });
  assert.equal(body.new_creation.min_created, '300s');
  assert.equal(body.new_creation.max_created, '3600s');
  assert.equal(typeof body.new_creation.min_created, 'string');
});

test('durations normalise across the units the API accepts', () => {
  assert.equal(gmgnDuration(90), '90s', 'a bare number is seconds, matching config.minAgeSec');
  assert.equal(gmgnDuration('300s'), '300s');
  assert.equal(gmgnDuration('5m'), '5m');
  assert.equal(gmgnDuration('2h'), '120m', 'hours are converted rather than trusted');
  assert.equal(gmgnDuration('1d'), '1440m');
  assert.equal(gmgnDuration('  15m  '), '15m');
});

test('a duration that cannot be expressed stops the request instead of being dropped', () => {
  for (const bad of [0, -1, NaN, 'soon', '', null, '5m30s']) {
    assert.throws(() => gmgnDuration(bad), TypeError, `rejected: ${JSON.stringify(bad)}`);
  }
  // The client contract is "never throws", so it degrades into an explained null
  // and spends no request - a widened query would be worse than no query.
  let calls = 0;
  const client = new GmgnClient({ apiKey: 'k', fetchImpl: async () => { calls++; return ok({}); } });
  return client.trenches('sol', { filters: { min_created: 'whenever' } }).then((rows) => {
    assert.equal(rows, null);
    assert.equal(calls, 0, 'nothing was sent');
    assert.equal(client.snapshot().lastErrorCode, 'FILTER_INVALID');
  });
});

test('the limit is clamped to what the server honours, and zero means unset', () => {
  assert.equal(buildTrenchesBody({ chain: 'sol', types: ['new_creation'], limit: 5_000 }).new_creation.limit, 80);
  assert.equal(buildTrenchesBody({ chain: 'sol', types: ['new_creation'], limit: 12 }).new_creation.limit, 12);
  // 0 is not a meaningful page size, so it falls back to the default rather than
  // asking the API for nothing.
  assert.equal(buildTrenchesBody({ chain: 'sol', types: ['new_creation'], limit: 0 }).new_creation.limit, 80);
});

test('the API key comes from the environment first and the CLI config file second', () => {
  assert.equal(loadApiKey({ env: { GMGN_API_KEY: 'from-env' } }), 'from-env');
  const file = 'GMGN_CHAIN=sol\nGMGN_API_KEY="from-file"\nGMGN_PRIVATE_KEY=-----BEGIN-----\n';
  assert.equal(loadApiKey({ env: {}, readFile: () => file }), 'from-file');
  assert.equal(loadApiKey({ env: {}, readFile: () => { throw new Error('missing'); } }), '');
});

test('the signing key is never read, even when the config file sits right there', () => {
  const file = 'GMGN_API_KEY=readable\nGMGN_PRIVATE_KEY=super-secret\n';
  const key = loadApiKey({ env: {}, readFile: () => file });
  assert.equal(key, 'readable');
  assert.ok(!key.includes('secret'));
});

test('a row is normalised without inventing values the provider did not send', () => {
  const row = normalizeTrenchesRow(trenchesRow({ holder_count: undefined, top_10_holder_rate: undefined }), 'sol', 111);
  assert.equal(row.provider, 'GMGN');
  assert.equal(row.address, SOL_MINT);
  assert.equal(row.marketCap, 2088.6);
  assert.equal(row.liquidity, 902.43);
  assert.equal(row.holders, null, 'an absent holder count is unknown, not zero');
  assert.equal(row.top10Rate, null);
  assert.equal(row.observedAt, 111);
});

test('a zero rate survives normalisation because zero is a real reading', () => {
  const row = normalizeTrenchesRow(trenchesRow({ top_10_holder_rate: 0, rug_ratio: 0, buy_tax: '0' }), 'sol', 1);
  assert.equal(row.top10Rate, 0);
  assert.equal(row.rugRatio, 0);
  assert.equal(row.buyTax, 0);
});

test('the string flags the provider sends become booleans, and junk stays unknown', () => {
  const row = normalizeTrenchesRow(trenchesRow({ renounced_mint: '1', renounced_freeze_account: '0', is_wash_trading: 'maybe' }), 'sol', 1);
  assert.equal(row.renouncedMint, true);
  assert.equal(row.renouncedFreeze, false);
  assert.equal(row.washTrading, null);
});

test('a rate outside 0..1 is rejected rather than passed through', () => {
  const row = normalizeTrenchesRow(trenchesRow({ progress: 2.5, top_10_holder_rate: -0.1 }), 'sol', 1);
  assert.equal(row.progress, null);
  assert.equal(row.top10Rate, null);
});

test('the address keeps its chain suffix stripped', () => {
  assert.equal(gmgnBareAddress('sol', SOL_MINT + '-solana'), SOL_MINT);
  assert.equal(gmgnBareAddress('sol', SOL_MINT), SOL_MINT);
});

test('a client without an API key reports why and spends nothing', async () => {
  let calls = 0;
  const client = new GmgnClient({ apiKey: '', fetchImpl: async () => { calls++; return ok({}); } });
  assert.equal(await client.trenches('sol'), null);
  assert.equal(calls, 0, 'no request is sent without a key');
  assert.equal(client.snapshot().lastErrorCode, 'NO_API_KEY');
  assert.equal(client.snapshot().enabled, false);
});

test('a request carries the API key and a fresh timestamp/client_id pair', async () => {
  const seen = [];
  const client = new GmgnClient({
    apiKey: 'k', now: () => 1_791_004_000_000,
    fetchImpl: async (url, init) => { seen.push({ url, init }); return ok({ new_creation: [] }); }
  });
  await client.trenches('sol');
  const { url, init } = seen[0];
  assert.equal(init.headers['X-APIKEY'], 'k');
  assert.equal(init.method, 'POST');
  assert.match(url, /timestamp=1791004000/);
  assert.match(url, /client_id=[0-9a-f-]{36}/);
  assert.equal(client.snapshot().ok, 1);
});

test('an API error is reported through health instead of throwing', async () => {
  const client = new GmgnClient({ apiKey: 'k', fetchImpl: async () => jsonResponse({ code: 4001, error: 'BAD_INPUT' }) });
  assert.equal(await client.trenches('sol'), null);
  assert.equal(client.snapshot().lastErrorCode, 'BAD_INPUT');
  assert.equal(client.snapshot().failed, 1);
  assert.equal(client.cooling(), false, 'a plain API error is not a rate limit');
});

test('a ban puts the client in cooldown until the reset the server named', async () => {
  let calls = 0;
  const now = 1_791_000_000_000;
  const client = new GmgnClient({
    apiKey: 'k', now: () => now,
    fetchImpl: async () => {
      calls++;
      return jsonResponse(
        { code: 429, error: 'RATE_LIMIT_BANNED', reset_at: Math.floor(now / 1000) + 40 },
        429
      );
    }
  });
  await client.trenches('sol');
  const afterBan = client.snapshot();
  assert.equal(afterBan.banned, 1);
  assert.ok(afterBan.cooling, 'the client is cooling');
  assert.equal(afterBan.retryAt, now + 41_000, 'reset_at plus a second of headroom');

  const before = calls;
  assert.equal(await client.trenches('sol'), null);
  assert.equal(calls, before, 'nothing is sent while cooling');
  assert.equal(client.snapshot().lastErrorCode, 'COOLING');
});

test('the reset header is honoured when the body does not name one', async () => {
  const now = 1_791_000_000_000;
  const client = new GmgnClient({
    apiKey: 'k', now: () => now,
    fetchImpl: async () => jsonResponse(
      { code: 429, error: 'RATE_LIMIT_EXCEEDED' }, 429,
      { 'x-ratelimit-reset': String(Math.floor(now / 1000) + 10) }
    )
  });
  await client.trenches('sol');
  assert.equal(client.snapshot().throttled, 1);
  assert.equal(client.snapshot().retryAt, now + 11_000);
});

test('repeated bans escalate to the long cooldown instead of retrying at the boundary', async () => {
  let clock = 1_791_000_000_000;
  const client = new GmgnClient({
    apiKey: 'k', now: () => clock,
    sleep: async (ms) => { clock += ms; },
    minGapMs: 0,
    strikeCooldownMs: 300_000,
    fetchImpl: async () => jsonResponse(
      { code: 429, error: 'RATE_LIMIT_BANNED', reset_at: Math.floor(clock / 1000) + 5 }, 429
    )
  });
  await client.trenches('sol');
  const first = client.snapshot().retryAt - clock;
  client.retryAt = 0;
  await client.trenches('sol');
  const second = client.snapshot().retryAt - clock;
  assert.ok(second > first, 'a second strike waits longer than the first');
  assert.equal(first, 6_000, 'reset_at (5s) plus a second of headroom past the deadline');
  assert.equal(second, 300_000, 'a repeat offender waits out the long cooldown');
  assert.equal(client.snapshot().strikes, 2);
});

test('a success clears the strike count', async () => {
  let clock = 1_791_000_000_000;
  let first = true;
  const client = new GmgnClient({
    apiKey: 'k', now: () => clock,
    sleep: async (ms) => { clock += ms; },
    minGapMs: 0,
    fetchImpl: async () => {
      if (first) { first = false; return jsonResponse({ code: 429, error: 'RATE_LIMIT_EXCEEDED', reset_at: Math.floor(clock / 1000) }, 429); }
      return ok({ new_creation: [] });
    }
  });
  await client.trenches('sol');
  assert.equal(client.snapshot().strikes, 1);
  assert.equal(await client.trenches('sol'), null, 'still cooling');
  client.retryAt = 0;
  await client.trenches('sol');
  assert.equal(client.snapshot().strikes, 0);
});

// The pacing pause is derived from the injected clock, so a clock that never
// advances would recompute the same pause forever. This pins the budget that
// makes the loop terminate regardless - it is what stopped the suite hanging.
test('a clock that never advances cannot livelock the pacing loop', async () => {
  const slept = [];
  const client = new GmgnClient({
    apiKey: 'k', now: () => 1_791_000_000_000,
    sleep: async (ms) => { slept.push(ms); },
    minGapMs: 1_200,
    fetchImpl: async () => ok({ new_creation: [] })
  });
  await client.trenches('sol');
  assert.equal(await client.trenches('sol'), null);
  assert.equal(client.snapshot().lastErrorCode, 'PACING_OVERFLOW');
  assert.ok(slept.length > 0 && slept.length < 30, `gave up after ${slept.length} naps`);
});

test('no failure path throws - not a rejected fetch, not a bad body', async () => {
  const boom = new GmgnClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(await boom.trenches('sol'), null);
  assert.equal(boom.snapshot().lastErrorCode, 'Error');

  const junk = new GmgnClient({ apiKey: 'k', fetchImpl: async () => jsonResponse('<html>nope</html>') });
  assert.equal(await junk.trenches('sol'), null);
  assert.equal(junk.snapshot().lastErrorCode, 'INVALID_JSON');

  const huge = new GmgnClient({ apiKey: 'k', maxResponseBytes: 1_024, fetchImpl: async () => jsonResponse({ code: 0, data: { pad: 'x'.repeat(5_000) } }) });
  assert.equal(await huge.trenches('sol'), null);
  assert.equal(huge.snapshot().lastErrorCode, 'RESPONSE_TOO_LARGE');
});

test('a route with no definition is refused rather than guessed at', async () => {
  const client = new GmgnClient({ apiKey: 'k', fetchImpl: async () => ok({}) });
  assert.equal(await client.request('swap', {}), null);
});

test('trenches dedupes across categories and tags which bucket each row came from', async () => {
  const client = new GmgnClient({
    apiKey: 'k',
    fetchImpl: async () => ok({
      new_creation: [trenchesRow()],
      near_completion: [trenchesRow({ symbol: 'boocat2' })],
      completed: []
    })
  });
  const rows = await client.trenches('sol');
  assert.equal(rows.length, 1, 'the same address in two buckets is one row');
  assert.equal(rows[0].bucket, 'new_creation');
});

test('a payload that is not an object yields null rather than an empty success', async () => {
  const client = new GmgnClient({ apiKey: 'k', fetchImpl: async () => ok(null) });
  assert.equal(await client.trenches('sol'), null);
});

test('pacing waits out the minimum gap rather than firing back to back', async () => {
  const slept = [];
  let clock = 1_791_000_000_000;
  const client = new GmgnClient({
    apiKey: 'k',
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    minGapMs: 1_200,
    fetchImpl: async () => ok({ new_creation: [] })
  });
  await client.trenches('sol');
  await client.trenches('sol');
  assert.ok(slept.some((ms) => ms >= 1_200), 'the second call waited for the gap');
});
