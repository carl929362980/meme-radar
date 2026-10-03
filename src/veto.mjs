// The pre-flight read: everything this project can honestly say about a lead
// before any money is at risk — and, just as importantly, what it cannot say.
//
// Two rules govern this file.
//
// 1. A check may only fire on a field the provider actually answered *for this
//    chain*. A missing field means "not assessed", never "passed". The whole
//    value of a veto list is that its silences are honest; a gate that reads a
//    null as a pass is worse than no gate at all, because it launders an unknown
//    into a reassurance. Which checks exist per chain was decided by measured
//    coverage over 263 SOL and 170 BSC rows, not by what the documentation
//    claims (re-runnable: .workbuddy/source-calibration/coverage-trenches.mjs).
//
// 2. The two chains get different check lists rather than a shared list with
//    holes in it. BSC's response carries no rug_ratio, no is_wash_trading and no
//    renounced_* at all. Those checks are therefore *absent* on BSC, because a
//    check that can never fire still shows up in a badge count and reads as a
//    pass to everyone looking at it. (A later sample found rug_ratio on 15 of 60
//    BSC rows, so the honest statement is not "never present" but "present for a
//    quarter of them" - and a check that can only judge a quarter of the field,
//    while the rest silently pass, is the same problem wearing a different hat.)
//
// 3. A check must separate rows, not describe them. This one was learned the
//    expensive way: the first draft of this file shipped two vetoes borrowed from
//    a published checklist, and against 263 real SOL rows they fired on 66% and
//    70% of *everything*. A rule that fires on most of the field carries no
//    information, and it costs more than nothing - a panel where most cards read
//    "vetoed" trains the reader to ignore the word. Every rule below has had its
//    fire rate measured, and the ones that described the population were either
//    retuned against the real distribution or turned around to point at the rare
//    side of it. Re-measure with `.workbuddy/source-calibration/calibrate-veto.mjs`
//    before trusting, and again after any threshold change.
//
// Nothing here throws, and nothing here invents a number. `null` in, `null` out.
export const VETO_STATES = Object.freeze(['BLOCK', 'CAUTION', 'CLEAR', 'UNKNOWN']);

// A verdict of CLEAR is a claim that we looked and found nothing. It may only be
// made when enough of the list was actually answerable; below this, the honest
// word is "unknown". Four of the BSC chain's checks are structurally absent, so
// this floor is what separates "clean" from "we could not see".
const MIN_ASSESSED = 6;

// Promotional bait is the one name pattern with essentially no false positives:
// no token is legitimately called "AIRDROP CLAIM NOW".
const BAIT_PATTERN = /(?:^|[^a-z])(official|airdrop|claim|reward|bonus|giveaway|presale|whitelist|free|visit|claimnow|airdropclaim)(?:[^a-z]|$)/i;
const LINK_PATTERN = /(?:https?:|www\.|\.com\b|\.io\b|\.xyz\b|t\.me\/)/i;

// Impersonating a major asset is suggestive rather than conclusive - there are
// real meme tokens named after majors - so this one warns instead of vetoing.
// Matching is on the whole alphanumeric core so "Pepe" trips it but "PepeCoin2"
// and "PEPEAI" do not, which keeps the signal about impersonation rather than
// about the word appearing anywhere in a longer name.
const MAJOR_TICKERS = Object.freeze(['btc', 'eth', 'usdt', 'usdc', 'bnb', 'sol', 'doge', 'xrp', 'ada', 'trump', 'musk', 'pepe', 'shib']);

// Thresholds. Where a published rung exists it is used; the rest were set by
// measuring what real rows actually look like, and that measurement is the part
// that matters — `.workbuddy/source-calibration/calibrate-veto.mjs` prints, for
// every rule, the share of real rows it fires on. A rule firing on more than
// roughly half the field is describing the population rather than separating it,
// and the first draft of this file had two such rules.
const BAR = Object.freeze({
  // Per chain, because the populations differ by two orders of magnitude: across
  // 263 SOL rows the creator's launch count has a median of 201 and a 90th
  // percentile of 4,446; across 60 BSC rows the median is 6 and the 90th is 450.
  // One number for both would clear everything on one chain and veto nearly
  // everything on the other, which is the failure this field exists to avoid.
  creatorSpray: Object.freeze({ sol: 4_000, bsc: 500 }),
  bundlerRate: 0.3,        // the documented "bundled supply" line
  insiderRate: 0.3,        // the documented "suspected insider" line
  sniperHold: 0.3,         // snipers still holding a third of supply
  devHold: 0.05,           // a creator position worth noticing, not any position
  top10: 0.6,              // ten wallets holding most of the supply
  rugRatio: 0.3,           // the documented rug line
  entrapment: 0.3,
  botRate: 0.3,
  tax: 0.05,               // 5% each way; above this a round trip bleeds
  oneSidedShare: 0.95,     // one side is effectively the whole book
  oneSidedMinTrades: 8     // below this the split is noise, not a pattern
});

const ratio = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

// The creator's own position, reported as a label rather than a number.
//
// The first draft of this file vetoed `creator_close`. Measured over 263 SOL and
// 60 BSC rows, that label covers 66% and 60% of everything: on a brand-new pool,
// a creator having taken their allocation out is the ordinary course, not an
// exception. A veto that fires on two thirds of the field is not a filter, and a
// panel where most cards read "vetoed" teaches the reader to skip the word — the
// exact opposite of what a safety layer is for.
//
// The information is in the rarer case. A creator *still holding* is the other
// third, so that is where the signal points: a positive mark rather than a veto.
// The rule this file now follows is to aim the signal at the rare event, and to
// let the calibration script decide which side is rare rather than intuition.
const DEV_HELD = new Set(['creator_hold', 'creator_hold_more', 'creator_buy', 'creator_add', 'buy']);

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Every check has the same shape: return null when the underlying field was not
// answered, otherwise { hit, value }. The uniformity is what lets the coverage
// count below be computed rather than maintained by hand.
const CHECKS = Object.freeze([
  {
    code: 'CREATOR_SPRAY', level: 'BLOCK',
    evaluate: (f, chain) => {
      const value = count(f.creatorCreatedCount);
      const bar = BAR.creatorSpray[chain] ?? BAR.creatorSpray.bsc;
      return value === null ? null : { hit: value > bar, value };
    }
  },
  {
    code: 'NAME_BAIT', level: 'BLOCK',
    evaluate: (f) => {
      const name = String(f.name || f.symbol || '');
      if (!name) return null;
      return { hit: BAIT_PATTERN.test(name) || LINK_PATTERN.test(name), value: name.slice(0, 40) };
    }
  },
  {
    code: 'NAME_SQUAT', level: 'CAUTION',
    evaluate: (f) => {
      const core = normalizeName(f.symbol || f.name);
      if (!core) return null;
      return { hit: MAJOR_TICKERS.includes(core), value: String(f.symbol || '').slice(0, 20) };
    }
  },
  {
    code: 'POOL_DRAINED', level: 'BLOCK',
    evaluate: (f) => {
      const value = count(f.liquidity);
      return value === null ? null : { hit: value <= 0.4, value };
    }
  },
  {
    code: 'BUNDLER_HEAVY', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.bundlerRate);
      return value === null ? null : { hit: value > BAR.bundlerRate, value };
    }
  },
  {
    code: 'INSIDER_HEAVY', level: 'CAUTION',
    evaluate: (f) => {
      const trader = ratio(f.ratTraderRate);
      const holder = ratio(f.insiderHoldRate);
      if (trader === null && holder === null) return null;
      const worst = Math.max(trader ?? 0, holder ?? 0);
      return { hit: worst > BAR.insiderRate, value: worst };
    }
  },
  {
    code: 'SNIPER_HEAVY', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.sniperHoldRate);
      return value === null ? null : { hit: value > BAR.sniperHold, value };
    }
  },
  {
    code: 'DEV_HOLDS', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.devHoldRate);
      return value === null ? null : { hit: value > BAR.devHold, value };
    }
  },
  {
    code: 'TOP10_CONCENTRATED', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.top10Rate);
      return value === null ? null : { hit: value > BAR.top10, value };
    }
  },
  {
    code: 'BOT_HEAVY', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.botDegenRate);
      return value === null ? null : { hit: value > BAR.botRate, value };
    }
  },
  {
    code: 'ENTRAPMENT', level: 'CAUTION',
    evaluate: (f) => {
      const value = ratio(f.entrapmentRate);
      return value === null ? null : { hit: value > BAR.entrapment, value };
    }
  },
  {
    code: 'HIGH_TAX', level: 'CAUTION',
    evaluate: (f) => {
      const buy = ratio(f.buyTax);
      const sell = ratio(f.sellTax);
      if (buy === null && sell === null) return null;
      const worst = Math.max(buy ?? 0, sell ?? 0);
      return { hit: worst > BAR.tax, value: worst };
    }
  },
  // Present only where the chain answers it. See the header: an always-silent
  // check is not a harmless no-op, it is a badge that reads as a pass.
  {
    code: 'RUG_RISK', level: 'CAUTION', chains: ['sol'],
    evaluate: (f) => {
      const value = ratio(f.rugRatio);
      return value === null ? null : { hit: value > BAR.rugRatio, value };
    }
  },
  {
    code: 'WASH_TRADING', level: 'CAUTION', chains: ['sol'],
    evaluate: (f) => (typeof f.washTrading !== 'boolean' ? null : { hit: f.washTrading, value: f.washTrading })
  },
  {
    code: 'AUTHORITY_LIVE', level: 'CAUTION', chains: ['sol'],
    evaluate: (f) => (typeof f.renouncedMint !== 'boolean' ? null : { hit: f.renouncedMint === false, value: f.renouncedMint })
  }
]);

// The other direction. A checklist that can only subtract will always be silent
// about the thing worth finding, and on this data the rare case *is* the good
// one: a creator still holding their allocation, on a pool minutes old, is the
// minority. These are reported beside the risks rather than folded into them, so
// a card can say "and one thing in its favour" instead of only ever saying no.
const POSITIVES = Object.freeze([
  {
    code: 'DEV_PRESENT',
    evaluate: (f) => {
      const status = typeof f.creatorTokenStatus === 'string' && f.creatorTokenStatus ? f.creatorTokenStatus.toLowerCase() : null;
      return status === null ? null : { hit: DEV_HELD.has(status), value: status };
    }
  }
]);

// Checks that no route in this product answers today, kept as a named list so
// the page can say "not assessed" out loud instead of quietly omitting them.
// A user who cannot tell "clean" from "unlooked" will read every clean card as
// a promise, which is the one failure mode this project cannot afford.
export const UNASSESSED_ALWAYS = Object.freeze([
  'HONEYPOT',   // sell-side restriction: only a per-token route answers this
  'LOCK'        // LP lock / burn state: same route, and it is rate-banned
]);

// Every code a verdict can carry, exported so a projection can whitelist against
// the one list rather than keeping its own copy of it. A second copy is how a
// sanitiser silently starts dropping reasons that were added later.
export const VETO_CODES = Object.freeze([...CHECKS.map((check) => check.code), 'ONE_SIDED_FLOW',
  ...POSITIVES.map((check) => check.code), ...UNASSESSED_ALWAYS]);
export const VETO_LEVELS = Object.freeze(['BLOCK', 'CAUTION']);

// `flow` is optional local evidence: the wallet feed's own buy/sell split for
// this address. It is computed here rather than read from the provider because a
// one-sided book is a property of the trades, not of any single snapshot field.
function assessFlow(flow) {
  if (!flow || typeof flow !== 'object') return null;
  const buys = count(flow.buys);
  const sells = count(flow.sells);
  if (buys === null || sells === null) return null;
  const total = buys + sells;
  if (total < BAR.oneSidedMinTrades) return null;
  const buyShare = buys / total;
  const side = buyShare >= 0.5 ? 'buy' : 'sell';
  const share = buyShare >= 0.5 ? buyShare : 1 - buyShare;
  return { hit: share >= BAR.oneSidedShare, value: { side, share, total } };
}

export function assessLead(input = {}, options = {}) {
  // A default parameter only covers `undefined`, not `null`, and this is called
  // on rows that came out of a provider parse - so the guard has to be explicit.
  const source = input && typeof input === 'object' ? input : {};
  const facts = source.facts && typeof source.facts === 'object' ? source.facts : source;
  const chain = String(source.chain || '');
  const reasons = [];
  const unassessed = [];
  let assessed = 0;

  for (const check of CHECKS) {
    if (check.chains && !check.chains.includes(chain)) continue;
    let outcome = null;
    try { outcome = check.evaluate(facts, chain); } catch { outcome = null; }
    if (outcome === null) continue;
    assessed++;
    if (outcome.hit) reasons.push({ code: check.code, level: check.level, value: outcome.value });
  }

  // Positives are collected separately and never touch the state. Finding
  // something in a lead's favour does not make an unassessed checklist assessed,
  // and it must never soften a veto another rule has already raised.
  const positives = [];
  for (const check of POSITIVES) {
    let outcome = null;
    try { outcome = check.evaluate(facts, chain); } catch { outcome = null; }
    if (outcome !== null && outcome.hit) positives.push({ code: check.code, value: outcome.value });
  }

  const flowOutcome = assessFlow(source.flow);
  if (flowOutcome !== null) {
    assessed++;
    if (flowOutcome.hit) reasons.push({ code: 'ONE_SIDED_FLOW', level: 'CAUTION', value: flowOutcome.value });
  }

  // Ordering is deliberate: a veto must never be pushed below a warning by
  // however many warnings happen to be present.
  reasons.sort((a, b) => (a.level === b.level ? 0 : a.level === 'BLOCK' ? -1 : 1));

  if (options.assumeUnassessed !== false) unassessed.push(...UNASSESSED_ALWAYS);

  const blocked = reasons.some((reason) => reason.level === 'BLOCK');
  const cautioned = reasons.length > 0;
  const state = blocked ? 'BLOCK'
    : cautioned ? 'CAUTION'
      : assessed >= MIN_ASSESSED ? 'CLEAR'
        : 'UNKNOWN';

  const total = assessed + unassessed.length;
  return {
    state,
    reasons: reasons.map((reason) => ({ code: reason.code, level: reason.level, value: reason.value })),
    positives: positives.map((positive) => ({ code: positive.code, value: positive.value })),
    unassessed,
    assessed,
    // Exposed as a rate so a card can show "12 of 14 checks ran" without having
    // to know how many checks exist for the chain.
    coverage: total > 0 ? assessed / total : 0
  };
}
