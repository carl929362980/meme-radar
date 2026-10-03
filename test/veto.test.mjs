import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLead, VETO_STATES, UNASSESSED_ALWAYS } from '../src/veto.mjs';

// A lead that passes everything. Every field below is one the provider actually
// answers for both chains (coverage measured over 263 SOL / 170 BSC rows), so a
// healthy fixture can only produce CLEAR - which is the point of it.
const clean = (over = {}) => ({
  chain: 'sol',
  facts: {
    symbol: 'GOLDDOG', name: 'Gold Dog',
    creatorCreatedCount: 3, creatorTokenStatus: 'creator_hold',
    liquidity: 8_000, bundlerRate: 0.01,
    ratTraderRate: 0.01, insiderHoldRate: 0.01,
    sniperHoldRate: 0.01, devHoldRate: 0, top10Rate: 0.2,
    botDegenRate: 0.01, entrapmentRate: 0, buyTax: 0, sellTax: 0,
    rugRatio: 0.01, washTrading: false, renouncedMint: true,
    ...over
  }
});

const codes = (result) => result.reasons.map((reason) => reason.code);

test('a lead with nothing to report is cleared, because the checks really did run', () => {
  const result = assessLead(clean());
  assert.equal(result.state, 'CLEAR');
  assert.deepEqual(result.reasons, []);
  assert.ok(result.assessed >= 6, `too few checks ran to justify a clearance: ${result.assessed}`);
});

test('the provider not answering a field never counts as a pass', () => {
  // Every field the checks read, removed. The verdict must be "we could not
  // look", not "clean" - that distinction is the entire reason this module
  // exists, and it is the one a badge count is most likely to erase.
  const silent = assessLead({ chain: 'sol', facts: { symbol: 'X', name: 'X' } });
  assert.equal(silent.state, 'UNKNOWN');
  assert.deepEqual(silent.reasons, []);
  assert.equal(silent.assessed, 2, 'only the two name patterns could be judged');
});

test('a check that cannot fire on this chain is absent, not silently passing', () => {
  // rug_ratio / is_wash_trading / renounced_* are missing from BSC's payload
  // entirely. Feeding them in anyway must not produce a verdict, because a
  // permanently silent check reads as a pass to anyone counting badges.
  const bsc = assessLead({ ...clean(), chain: 'bsc' });
  assert.equal(bsc.state, 'CLEAR');

  const bscDirty = assessLead({ chain: 'bsc', facts: { ...clean().facts, rugRatio: 0.9, washTrading: true, renouncedMint: false } });
  assert.deepEqual(bscDirty.reasons.filter((reason) => ['RUG_RISK', 'WASH_TRADING', 'AUTHORITY_LIVE'].includes(reason.code)), [],
    'these are SOL-only measurements and must not be applied to a chain that never reported them');

  const solDirty = assessLead({ ...clean(), facts: { ...clean().facts, rugRatio: 0.9, washTrading: true, renouncedMint: false } });
  assert.deepEqual(codes(solDirty).sort(), ['AUTHORITY_LIVE', 'RUG_RISK', 'WASH_TRADING']);
  assert.ok(solDirty.assessed > bsc.assessed, 'the SOL list is longer because SOL answers more questions');
});

test('a veto outranks any number of warnings, and is listed first', () => {
  const result = assessLead({ ...clean(), facts: { ...clean().facts,
    creatorCreatedCount: 9_999, bundlerRate: 0.5, top10Rate: 0.9, sniperHoldRate: 0.5 } });
  assert.equal(result.state, 'BLOCK');
  assert.equal(result.reasons[0].code, 'CREATOR_SPRAY');
  assert.equal(result.reasons[0].level, 'BLOCK');
  assert.ok(result.reasons.length > 1, 'the warnings are still reported, just not first');
  assert.equal(result.reasons.filter((reason) => reason.level === 'BLOCK').length, 1);
});

test('the creator threshold sits where each chain own data actually varies', () => {
  // Two chains, two scales. Over 263 SOL rows the creator's launch count has a
  // median of 201 and a ninetieth percentile of 4,446; over 60 BSC rows the
  // median is 6 and the ninetieth is 450. A single number cannot serve both, so
  // the bar is per chain and both are pinned here.
  assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, creatorCreatedCount: 4_000 } }).state, 'CLEAR');
  assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, creatorCreatedCount: 4_001 } }).state, 'BLOCK');
  assert.equal(assessLead({ chain: 'bsc', facts: { ...clean().facts, creatorCreatedCount: 500 } }).state, 'CLEAR');
  assert.equal(assessLead({ chain: 'bsc', facts: { ...clean().facts, creatorCreatedCount: 501 } }).state, 'BLOCK');
  // The bar is high because the population is: the calibration script reports a
  // bar of 20 firing on 70% of SOL rows, which is a description of the field
  // rather than a filter on it. A value that used to be a veto is now ordinary.
  assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, creatorCreatedCount: 288 } }).state, 'CLEAR');
});

// The lesson this file carries, in a test. The first draft vetoed a creator who
// had already taken their allocation out. Measured over real rows that label
// covers two thirds of every new pool - it is the default course of events, not a
// warning - so the veto refused most of the field and said nothing. The signal is
// on the other side, where the minority is.
test('a creator who has left is the ordinary case, so the signal points the other way', () => {
  const left = assessLead({ ...clean(), facts: { ...clean().facts, creatorTokenStatus: 'creator_close' } });
  assert.equal(left.state, 'CLEAR', 'the common case cannot be a veto');
  assert.deepEqual(left.reasons, []);
  assert.deepEqual(left.positives, [], 'and it earns no credit either - it is simply the norm');

  const held = assessLead(clean());
  assert.deepEqual(held.positives.map((row) => row.code), ['DEV_PRESENT']);
  assert.equal(held.positives[0].value, 'creator_hold');
  assert.equal(held.state, 'CLEAR', 'a positive never moves the state on its own');

  // An unread label is unassessed in both directions, never a silent negative.
  const unknown = assessLead({ ...clean(), facts: { ...clean().facts, creatorTokenStatus: null } });
  assert.deepEqual(unknown.positives, []);
  assert.equal(unknown.state, 'CLEAR');

  // Matched loosely, because the labels are not stable across chains.
  for (const status of ['creator_hold_more', 'creator_buy', 'BUY']) {
    assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, creatorTokenStatus: status } }).positives.length, 1, status);
  }
  for (const status of ['creator_close', 'creator_sell_all', 'sell']) {
    assert.deepEqual(assessLead({ ...clean(), facts: { ...clean().facts, creatorTokenStatus: status } }).positives, [], status);
  }
});

test('something in a lead favour never softens what is against it', () => {
  const result = assessLead({ ...clean(), facts: { ...clean().facts, creatorCreatedCount: 9_999 } });
  assert.equal(result.state, 'BLOCK');
  assert.deepEqual(result.positives.map((row) => row.code), ['DEV_PRESENT'],
    'the good news is still reported, it just does not buy anything');
});

test('name bait is a veto, but only on patterns that are not real names', () => {
  for (const name of ['FREE AIRDROP', 'Official Claim', 'visit t.me/xyz', 'BONUS']) {
    const result = assessLead({ ...clean(), facts: { ...clean().facts, name } });
    assert.equal(result.state, 'BLOCK', `${name} should be vetoed`);
  }
  for (const name of ['Gold Dog', 'MoonCat', 'Freezer']) {
    // "Freezer" contains "free" but not as a word - a substring match here would
    // veto a large share of ordinary names, which is how a filter becomes noise.
    assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, name } }).state, 'CLEAR', `${name} should pass`);
  }
});

test('impersonating a major is a warning rather than a veto', () => {
  // Real meme tokens are named after majors, so this cannot be a veto without
  // becoming wrong. It warns; the higher bars stay untouched.
  const squat = assessLead({ ...clean(), facts: { ...clean().facts, symbol: 'PEPE', name: 'Pepe' } });
  assert.equal(squat.state, 'CAUTION');
  assert.deepEqual(codes(squat), ['NAME_SQUAT']);

  // The match is on the whole alphanumeric core, so a longer name that merely
  // contains a ticker is not an impersonation of it.
  assert.equal(assessLead({ ...clean(), facts: { ...clean().facts, symbol: 'PEPEAI', name: 'Pepe AI' } }).state, 'CLEAR');
});

test('the one-sided book needs a real sample before it means anything', () => {
  const withFlow = (flow) => assessLead({ ...clean(), flow });
  // Seven trades all one way is a quiet minute, not a pattern.
  assert.equal(withFlow({ buys: 7, sells: 0 }).state, 'CLEAR');
  // Eight is the floor, and 8/8 clears the share bar.
  const fired = withFlow({ buys: 8, sells: 0 });
  assert.equal(fired.state, 'CAUTION');
  assert.deepEqual(codes(fired), ['ONE_SIDED_FLOW']);
  assert.equal(fired.reasons[0].value.side, 'buy');
  // Both directions genuinely present: no fire, however busy. (A 500:3 split
  // *is* a one-sided book, and the engine is right to call it one - which is why
  // this pair is deliberately lopsided-but-real rather than large.)
  assert.equal(withFlow({ buys: 300, sells: 120 }).reasons.some((reason) => reason.code === 'ONE_SIDED_FLOW'), false);
  assert.equal(withFlow({ buys: 500, sells: 3 }).reasons.some((reason) => reason.code === 'ONE_SIDED_FLOW'), true,
    'the share bar is about proportion, not sample size');
  // A sell-only book reports the sell side, not the largest number.
  assert.equal(withFlow({ buys: 0, sells: 9 }).reasons[0].value.side, 'sell');
  // No flow at all is simply unassessed, and must not block a clearance.
  assert.equal(withFlow(undefined).state, 'CLEAR');
  assert.equal(withFlow({ buys: 3 }).state, 'CLEAR', 'a half-formed reading is not a reading');
});

test('every reason carries a code the page can name, and an appraised value', () => {
  const result = assessLead({ ...clean(), facts: { ...clean().facts, bundlerRate: 0.44, top10Rate: 0.75 } });
  for (const reason of result.reasons) {
    assert.match(reason.code, /^[A-Z0-9_]+$/);
    assert.ok(['BLOCK', 'CAUTION'].includes(reason.level));
    assert.notEqual(reason.value, undefined);
  }
  assert.equal(result.reasons.find((reason) => reason.code === 'BUNDLER_HEAVY').value, 0.44);
});

test('what this product cannot see is stated, not omitted', () => {
  const result = assessLead(clean());
  assert.deepEqual(result.unassessed, [...UNASSESSED_ALWAYS]);
  assert.ok(result.unassessed.includes('HONEYPOT') && result.unassessed.includes('LOCK'),
    'a sell restriction and an LP lock are the two questions no route here answers today');
  assert.ok(result.coverage < 1, 'coverage must never claim a complete picture');
  assert.ok(result.coverage > 0.8);
});

test('a malformed lead is described, never thrown on', () => {
  for (const input of [undefined, null, {}, { chain: 'sol' }, { facts: {} }, { facts: { liquidity: 'x' } },
    { chain: 'bsc', facts: { creatorCreatedCount: -1 } }, { chain: 'sol', flow: 'nonsense' }]) {
    const result = assessLead(input);
    assert.ok(VETO_STATES.includes(result.state), `${JSON.stringify(input)} produced ${result.state}`);
    assert.ok(Array.isArray(result.reasons) && Array.isArray(result.unassessed));
  }
  assert.equal(assessLead(undefined).state, 'UNKNOWN');
  assert.equal(assessLead({ chain: 'sol', facts: { liquidity: -5 } }).state, 'UNKNOWN',
    'a negative liquidity is not a reading, so it retires rather than fires the check');
});

test('a value outside its own range does not become a false alarm', () => {
  // Rates are 0..1. A provider handing back 30 instead of 0.30 must not trip
  // every rate check at once - an unreadable value is an absent one.
  const result = assessLead({ ...clean(), facts: { ...clean().facts, bundlerRate: 30, top10Rate: 1.5 } });
  assert.equal(result.state, 'CLEAR');
  assert.deepEqual(result.reasons, []);
});
