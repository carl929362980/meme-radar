import crypto from 'node:crypto';
import { normalizeTokenAddress } from './address.mjs';

export const horizons = Object.freeze({ m5: 300_000, m15: 900_000, m30: 1800_000, h1: 3600_000, h2: 7200_000, h6: 21600_000, h24: 86400_000 });
const MAX_SAMPLE_ATTEMPTS = 3;
const MAX_SAMPLE_LATENESS_MS = 24 * 3600_000;
const PAUSE_CODES = new Set(['AVE_RATE_LIMITED', 'AVE_BUDGET', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_QUOTA', 'AVE_DISCOVERY_RESERVE', 'AVE_ABORTED', 'AVE_CHANGED', 'AVE_DISABLED']);

// Which provider may answer a row's read-back. One curve, one ruler: a baseline
// that provider X priced is only ever measured against provider X's own
// candles, because the gap between two rulers is not a market move.
//
// Two kinds of row this deliberately leaves unread, and the difference between
// them is the whole point:
//   * `baselineProvider: 'AVE'`  - readable, by AVE, for as long as that
//     provider is wired up. Rows like this are the historical record of the
//     machine's AVE era and are kept, not deleted and not converted.
//   * `baselineProvider: 'LEGACY_UNKNOWN'` or absent - written before
//     provenance was recorded at all. There is no ruler named on them, so
//     there is no honest way to measure them: they are kept for history and
//     counted as missing, never silently back-filled with whichever provider
//     happens to be connected today.
// A row is never re-labelled to make it readable.
export const readableBaseline = (row, providerName) =>
  typeof providerName === 'string' && providerName !== '' && row?.baselineProvider === providerName;

export function sampleRejected(outcomes, candidate, now) {
  if (candidate.status !== 'HARD_REJECT' || !(candidate.price > 0)) return outcomes;
  if (outcomes.some(row => row.address === candidate.address)) return outcomes;
  // Stable 1-in-5 sampling, independent of subsequent returns or popularity.
  const hash = crypto.createHash('sha256').update(`${candidate.chain}:${candidate.address}`).digest();
  if (hash[0] % 5 || outcomes.filter(row => row.initialDecision === 'HARD_REJECT').length >= 200) return outcomes;
  outcomes.push({ chain: candidate.chain, address: candidate.address, symbol: candidate.symbol,
    baselineAt: now, baselinePrice: candidate.price, baselineProvider: candidate.marketProvider || 'LEGACY_UNKNOWN', initialDecision: 'HARD_REJECT',
    latestDecision: candidate.status, latestFailed: candidate.deep?.failed || [], samples: {},
    sampling: 'SHA256_MOD5', strategyVersion: 'radar-v3' });
  return outcomes;
}

export function dueOutcomeJobs(outcomes, now) {
  return outcomes.flatMap(row => Object.entries(horizons).filter(([key, duration]) =>
    !row.samples?.[key] && now >= row.baselineAt + duration + 60_000
    && now >= (row.sampleRetries?.[key]?.nextAt || 0)
    && (row.sampleRetries?.[key]?.attempts || 0) < MAX_SAMPLE_ATTEMPTS
    && now - (row.baselineAt + duration) <= MAX_SAMPLE_LATENESS_MS
  ).map(([key, duration]) => ({ row, key, targetAt: row.baselineAt + duration })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt);
}

// The sampling frame the PRD asks for: every card the board actually printed,
// not only the ones the screen vetoed.
//
// Sampling rejects alone measures what the machine avoided and never what it
// missed - and "did this thing find anything" is the one question the outcome
// table exists to answer. It also cannot be answered in practice from rejects
// alone: they are sampled 1-in-5 and only after a deep audit, so on a quiet
// chain the frame stays empty for days while the board is in fact showing cards.
//
// The baseline is the board's own, not a fresh reading: the snapshot the card
// itself measures its ladder from, stamped with the moment that snapshot was
// taken. Using anything else would answer a different question than the board
// is asking.
//
// Returns { created, boarded, noPrice, unnamed, awaiting }: how many cards the
// board printed, how many entered the frame, and - the part that must never be
// silent - exactly why the rest did not.
//
// `noPrice` is the one that used to be invisible: a `continue` with no count at
// all, so a machine that had stopped being able to measure anything looked
// exactly like a market that had produced nothing to measure. `awaiting` carries
// the addresses behind it so the caller can go and get the missing reading
// rather than waiting for a rotation to reach it.
export const BOARDED_SAMPLE_LIMIT = 200;
// How many unpriced addresses a single report may ask a price for. A board that
// grew cannot grow one cycle's read budget with it.
const AWAITING_LIMIT = 60;

export function sampleBoarded(outcomes, records, now, { providers = {}, limit = BOARDED_SAMPLE_LIMIT } = {}) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const rows = (Array.isArray(records) ? records : [])
    .map(record => ({ record, address: normalizeTokenAddress(record?.chain, record?.address) }))
    // The board can carry a row whose address this build cannot normalise; it is
    // left alone rather than keyed loosely, which would merge two mints.
    .filter(entry => Boolean(entry.address));
  const ceiling = Number.isInteger(limit) && limit > 0 ? limit : BOARDED_SAMPLE_LIMIT;
  // Counted once, before the loop: the ceiling is on the frame's total size, and
  // counting the rows this call is itself adding would halve it.
  const existing = list.filter(row => row.initialDecision === 'X_REVIEW').length;
  let created = 0;
  let noPrice = 0;
  let unnamed = 0;
  let already = 0;
  const awaiting = [];
  for (const { record, address } of rows) {
    if (existing + created >= ceiling) break;
    const price = Number(record?.snapshot?.price);
    // No baseline price, no measurement - and no substitute: a market cap or a
    // zero standing in for it would fabricate every return that followed.
    if (!(price > 0)) {
      noPrice++;
      if (awaiting.length < AWAITING_LIMIT) awaiting.push(address);
      continue;
    }
    const providerName = providers?.[String(record?.source || 'market')];
    if (typeof providerName !== 'string' || !providerName) { unnamed++; continue; }
    if (list.some(row => normalizeTokenAddress(row.chain || record.chain, row.address) === address)) { already++; continue; }
    list.push({
      chain: record.chain,
      address,
      symbol: record?.symbol ?? null,
      baselineAt: Number(record?.snapshot?.at) || Number(record?.firstSeenAt) || now,
      baselinePrice: price,
      baselineProvider: providerName,
      initialDecision: 'X_REVIEW',
      latestDecision: 'X_REVIEW',
      latestFailed: [],
      samples: {},
      sampling: 'BOARDED',
      strategyVersion: 'radar-v3'
    });
    created++;
  }
  return { created, boarded: rows.length, noPrice, unnamed, already, awaiting };
}

export function selectOutcomeJobs(scopes, { enabledChains = [], provider = 'GMGN', limit = 0, now = Date.now() } = {}) {
  // Provider-agnostic on purpose. This used to be `provider !== 'AVE'` plus a
  // `baselineProvider === 'AVE'` filter, which silently produced zero jobs the
  // moment AVE stopped being the source. Now the name the caller passes is the
  // name a row must carry, so wiring a new provider in is a one-word change and
  // a forgotten one leaves rows unread rather than measured with a foreign ruler.
  if (typeof provider !== 'string' || !provider || !Number.isInteger(limit) || limit <= 0) return [];
  const enabled = new Set(enabledChains);
  return Object.entries(scopes).filter(([chain]) => enabled.has(chain))
    .flatMap(([chain, rows]) => dueOutcomeJobs(rows.filter(row => (!row.chain || row.chain === chain)
      && readableBaseline(row, provider)), now).map(job => ({ ...job, chain })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt)
    .slice(0, limit);
}

export async function collectOutcomeSamples(outcomes, provider, chain, { limit = 4, now = Date.now, deadline = Infinity, onlyKey, signal, providerName = 'GMGN' } = {}) {
  if (typeof provider.priceAt !== 'function') return outcomes;
  if (!Number.isInteger(limit) || limit <= 0) return outcomes;
  for (const job of dueOutcomeJobs(outcomes.filter(row => readableBaseline(row, providerName)), now()).filter(job => !onlyKey || job.key === onlyKey).slice(0, limit)) {
    if (signal?.aborted || now() >= deadline || provider.disabled || provider.nextAllowedAt > now()) break;
    const { row, key, targetAt } = job;
    let sample, errorCode = 'NO_CANDLE';
    try { sample = await provider.priceAt(row.address, targetAt, row.chain || chain, { signal }); }
    catch (error) {
      if (signal?.aborted) break;
      if (PAUSE_CODES.has(error?.code)) {
        row.sampleRetries ||= {};
        row.sampleRetries[key] = { attempts: row.sampleRetries[key]?.attempts || 0, code: error.code,
          nextAt: Math.max(now() + 120_000, Number(error.retryAt) || 0) };
        break;
      }
      errorCode = 'READ_FAILED';
    }
    if (signal?.aborted) break;
    row.samples ||= {};
    row.sampleRetries ||= {};
    if (sample && Number.isFinite(sample.price) && sample.price > 0 && row.baselinePrice > 0
      && Math.abs(sample.at - targetAt) <= 60_000 && sample.at <= now()) {
      row.samples[key] = { ...sample, targetAt, lagMs: sample.at - targetAt, collectedAt: now(), return: sample.price / row.baselinePrice - 1 };
      delete row.sampleRetries[key];
    } else {
      const attempts = (row.sampleRetries[key]?.attempts || 0) + 1;
      row.sampleRetries[key] = { attempts, code: errorCode, nextAt: now() + Math.min(3600_000, 120_000 * 2 ** Math.min(attempts - 1, 5)) };
    }
  }
  return outcomes;
}

export function outcomeCoverage(outcomes, now = Date.now()) {
  const cohort = decision => {
    const rows = outcomes.filter(row => row.initialDecision === decision);
    return Object.fromEntries(Object.entries(horizons).map(([key, duration]) => {
      const eligible = rows.filter(row => now >= row.baselineAt + duration);
      const values = eligible.map(row => row.samples?.[key]?.return).filter(Number.isFinite).sort((a, b) => a - b);
      const n = values.length;
      return [key, { eligible: eligible.length, completed: n, missing: eligible.length - n,
        median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
        positiveRate: n ? values.filter(x => x > 0).length / n : null }];
    }));
  };
  return { passed: cohort('X_REVIEW'), rejected: cohort('HARD_REJECT') };
}
