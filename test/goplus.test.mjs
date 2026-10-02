// The GoPlus reader exists to add two non-market facts to a tracked lead without
// ever being able to break a scan. These tests pin the properties that matter:
// throttling is detected from the body rather than the status line, a throttled
// batch stops instead of burning its budget, the per-cycle ceiling holds, the
// cache prevents repeat reads, and no failure path ever throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GoPlusReader, goplusIdentity, goplusEndpoint } from '../src/goplus.mjs';

function jsonResponse(body, status = 200) {
  const headers = new Map([['content-type', 'application/json']]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function recordWith(overrides = {}) {
  return {
    is_honeypot: '0', is_open_source: '1', is_mintable: '0', owner_change_balance: '0',
    hidden_owner: '0', cannot_sell_all: '0', selfdestruct: '0', external_call: '0',
    slippage_modifiable: '0', personal_slippage_modifiable: '0', transfer_pausable: '0',
    is_blacklisted: '0', trading_cooldown: '0', buy_tax: '0.01', sell_tax: '0.02',
    holders: [{ percent: '0.30' }, { percent: '0.15' }],
    ...overrides
  };
}

const BSC = '0x7A3f00299a61ca38c4d5981c34661f6bda4a7777';

test('holder concentration is read off the response and normalised to a fraction', async () => {
  const reader = new GoPlusReader({
    fetchImpl: async () => jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith() } })
  });
  const value = await reader.read('bsc', BSC);
  assert.ok(Math.abs(value.top10Rate - 0.45) < 1e-9, 'sum of the per-holder shares');
  assert.equal(value.security.verdict, 'NO_FATAL_FLAGS');
});

test('a missing holder distribution stays unknown instead of reading as zero concentration', async () => {
  const reader = new GoPlusReader({
    fetchImpl: async () => jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith({ holders: undefined }) } })
  });
  const value = await reader.read('bsc', BSC);
  assert.equal(value.top10Rate, null);
  assert.equal(value.security.verdict, 'NO_FATAL_FLAGS', 'the contract verdict is independent of the holder list');
});

test('throttling is read from the body, and a throttled batch stops spending', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const reader = new GoPlusReader({
    now: () => clock,
    minGapMs: 0,
    maxPerCycle: 10,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith() } })
        : jsonResponse({ code: 4029, message: 'too many requests' });
    }
  });
  reader.beginCycle();
  const leads = [1, 2, 3, 4].map(n => ({ chain: 'bsc', address: `0x${String(n).repeat(40).slice(0, 40)}` }));
  const out = await reader.enrich(leads);
  assert.equal(out.size, 1, 'only the first lead was readable');
  assert.equal(calls, 2, 'the throttle was noticed on the second call and the rest were abandoned');
  assert.equal(reader.snapshot().throttled, 1);
  assert.equal(reader.available('bsc'), false, 'the reader is cooling down');

  // Once the cooldown lapses the reader may try again.
  clock += 61_000;
  assert.equal(reader.available('bsc'), true);
});

test('the per-cycle ceiling caps reads and resets on the next cycle', async () => {
  let calls = 0;
  const reader = new GoPlusReader({
    minGapMs: 0,
    maxPerCycle: 2,
    fetchImpl: async () => { calls++; return jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith() } }); }
  });
  const leads = [1, 2, 3, 4, 5].map(n => ({ chain: 'bsc', address: `0x${String(n).repeat(40).slice(0, 40)}` }));
  reader.beginCycle();
  await reader.enrich(leads);
  assert.equal(calls, 2, 'never exceeds the cycle budget');
  reader.beginCycle();
  await reader.enrich(leads);
  assert.equal(calls, 4, 'a new cycle gets a fresh budget');
});

test('a cached lead is not read twice', async () => {
  let calls = 0;
  const reader = new GoPlusReader({
    minGapMs: 0,
    fetchImpl: async () => { calls++; return jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith() } }); }
  });
  await reader.read('bsc', BSC);
  const again = await reader.read('bsc', BSC);
  assert.equal(calls, 1);
  assert.ok(Math.abs(again.top10Rate - 0.45) < 1e-9, 'the cached value is still returned');
  assert.equal(reader.snapshot().cached, 1);
});

test('every failure path returns null without throwing', async () => {
  const cases = {
    network: async () => { throw new Error('socket closed'); },
    httpError: async () => jsonResponse({ code: 1 }, 500),
    notJson: async () => jsonResponse('<html>nope</html>'),
    upstreamRejected: async () => jsonResponse({ code: 4010, message: 'bad request' }),
    emptyResult: async () => jsonResponse({ code: 1, result: {} }),
    oversized: async () => jsonResponse(JSON.stringify({ code: 1, result: { a: 'x'.repeat(2_000) } }))
  };
  for (const [label, fetchImpl] of Object.entries(cases)) {
    const reader = new GoPlusReader({ minGapMs: 0, maxResponseBytes: 1_024, fetchImpl });
    const value = await reader.read('bsc', BSC);
    assert.equal(value, null, `${label} must degrade to null`);
  }
});

test('a cached lead is still served after the cycle budget is spent', async () => {
  // Otherwise the leads read first would pin the budget every cycle and the
  // rest of the board would never be enriched.
  let calls = 0;
  const reader = new GoPlusReader({
    minGapMs: 0,
    maxPerCycle: 1,
    fetchImpl: async () => { calls++; return jsonResponse({ code: 1, result: { [BSC.toLowerCase()]: recordWith() } }); }
  });
  const other = `0x${'9'.repeat(40)}`;
  reader.beginCycle();
  await reader.read('bsc', BSC);
  // Budget is now spent for this cycle.
  assert.equal(reader.available('bsc'), false);
  reader.beginCycle();
  const out = await reader.enrich([{ chain: 'bsc', address: BSC }, { chain: 'bsc', address: other }]);
  assert.equal(out.size, 2, 'the cached lead is served and the budget is then spent on the new one');
  assert.equal(calls, 2);
});

test('unverified chains and blank addresses are refused before any request', async () => {
  let calls = 0;
  const reader = new GoPlusReader({ fetchImpl: async () => { calls++; return jsonResponse({ code: 1, result: {} }); } });
  assert.equal(await reader.read('eth', BSC), null);
  assert.equal(await reader.read('bsc', ''), null);
  assert.equal(await reader.read('bsc', 'not-an-address'), null, 'a malformed address is not a chain we can look up');
  assert.equal(calls, 0);
});

test('address identity keeps Solana case but folds EVM case', () => {
  assert.equal(goplusIdentity('bsc', BSC), goplusIdentity('bsc', BSC.toLowerCase()));
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  assert.notEqual(goplusIdentity('sol', mint), goplusIdentity('sol', mint.toLowerCase()));
});

test('endpoints match the verified chain identifiers only', () => {
  assert.match(goplusEndpoint('bsc', BSC), /\/token_security\/56\?/);
  assert.match(goplusEndpoint('sol', 'x'), /\/solana\/token_security\?/);
  assert.equal(goplusEndpoint('eth', BSC), '', 'this build only carries bsc and sol');
});
