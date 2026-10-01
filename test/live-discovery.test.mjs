import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { LiveDiscovery, normalizeLiveRows } from '../src/live-discovery.mjs';
import { Scanner } from '../src/scanner.mjs';
import { RadarState } from '../src/state.mjs';
import { createServer } from '../src/server.mjs';

const now = 1800000000000;
const address = '0x' + '1'.repeat(40);
const token = (id = 1, overrides = {}) => ({ address:'0x'+id.toString(16).padStart(40,'0'), symbol:'T'+id, name:'Test',
  marketProvider:'AVE',chain:'bsc',market_cap:50000,liquidity:15000,launch_at:now/1000-1000,
  capturedAt:now,sourceUpdatedAt:now,expiresAt:now+30000,price:'1',volume_5m:1000,volume:1000,buys:10,sells:5,swaps:15,
  holder_count:100,smart_degen_count:3,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:0,...overrides });
// Solana needs a base58 token address; the 0x fixture only validates on EVM chains.
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
const options = provider => ({provider,now:()=>now,schedule:()=>({unref(){}}),cancel:()=>{}});
const flushBackground = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const overlayRow = (row, at, changes = {}) => ({ ...row, capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 20_000,
  stale: false, marketOverlayProvider: 'DEXSCREENER', market_cap: 51_000, volume_5m: 1_100, ...changes });

test('live requests use only the provider live read without legacy commands or deep audits', async () => {
  let called;
  const provider={ keyEpoch:0,configured:async()=>true,live:async (...args)=>{called=args;return {tokens:[],capturedAt:now};},
    run:async()=>{throw new Error('legacy command must not run');},audit:async()=>{throw new Error('audit must not run');} };
  const live=new LiveDiscovery(options(provider));live.touch('sol');await live.poll();
  assert.equal(called[0],'sol');assert.equal(called[1].refresh,true);assert.ok(called[1].signal instanceof AbortSignal);
  assert.equal(live.snapshot('sol').status,'READY');
  const legacy=new LiveDiscovery(options({keyEpoch:0,configured:async()=>true,run:provider.run}));
  legacy.touch('bsc');await legacy.poll();assert.equal(legacy.snapshot('bsc').status,'ERROR');
});

test('quick discovery drops explicit hazards and newborns, preserves unknowns and case-sensitive Solana addresses', () => {
  const rows=normalizeLiveRows([token(),token(2,{is_honeypot:1}),token(3,{is_wash_trading:true}),token(4,{rug_ratio:.4}),
    token(5,{launch_at:now/1000-200}),token(6,{liquidity:2000}),token(7,{address:'invalid'}),
    token(8,{marketProvider:'LEGACY_UNKNOWN'}),token(9,{smart_degen_count:null,rug_ratio:null,buy_tax:null,website:'javascript:alert(1)'})], 'bsc',[],now);
  assert.equal(rows.length,2); assert.equal(rows[1].smartMoney,null); assert.equal(rows[1].hasUnknownRisk,true);
  assert.equal(rows[1].auditEligible,true); assert.equal(rows[1].website,'');
  assert.ok(rows.every(row=>row.newAt===0 && row.priceDelta===null));
  const upper='So11111111111111111111111111111111111111112',lower='so11111111111111111111111111111111111111112';
  assert.equal(normalizeLiveRows([token(1,{address:upper,chain:'sol'}),token(2,{address:lower,chain:'sol'})],'sol',[],now).length,2);
  assert.equal(normalizeLiveRows([token(),token(1,{address:token().address.toUpperCase().replace('0X','0x')})],'bsc',[],now).length,1);
  assert.equal(normalizeLiveRows([token(1,{marketProvider:undefined}),token(2,{marketProvider:'LEGACY_UNKNOWN'})],'bsc',[],now).length,0);
  const redacted=normalizeLiveRows([token(1,{name:'gmgn_mocksecret12345'})],'bsc',[],now);
  assert.equal(redacted[0].name,'?');
});

test('snapshot changes use actual elapsed time; first load is not a stream of fake new arrivals', () => {
  const first=normalizeLiveRows([token()],'bsc',[],now);
  const updated={capturedAt:now+20000,sourceUpdatedAt:now+20000,expiresAt:now+50000};
  const second=normalizeLiveRows([token(1,{price:1.1,holder_count:103,...updated}),token(2,updated)],'bsc',first,now+20000,true);
  assert.ok(Math.abs(second[0].priceDelta-.1)<1e-9);assert.equal(second[0].deltaWindowMs,20000);
  assert.equal(second[0].holdersDelta,3);assert.equal(second[0].newAt,0);assert.equal(second[1].newAt,now+20000);
  const afterGap=normalizeLiveRows([token()],'bsc',first,now+180000,true);
  assert.equal(afterGap[0].priceDelta,null);
});

test('first qualification is separate from discovery and survives refresh, staleness and temporary exclusion', async () => {
  let at = now, mode = 'pending';
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ capturedAt: at,
    tokens: mode === 'absent' ? [] : [token(1, { capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 20_000,
      volume_5m: mode === 'pending' ? null : 1_000, ...(mode === 'excluded' ? { is_honeypot: 1 } : {}) })] }) };
  const live = new LiveDiscovery({ ...options(provider), cacheOnly: true, now: () => at });
  let snapshot = await live.readSnapshot('bsc');
  assert.equal(snapshot.rows[0].firstSeenAt, now);
  assert.equal(snapshot.rows[0].newAt, 0);
  assert.equal(snapshot.rows[0].qualifiedAt, null);
  at += 11 * 60_000; mode = 'ready';
  snapshot = await live.readSnapshot('bsc');
  const firstQualifiedAt = at;
  assert.equal(snapshot.rows[0].qualifiedAt, firstQualifiedAt);
  assert.equal(snapshot.rows[0].firstSeenAt, now);
  assert.equal(snapshot.rows[0].newAt, 0);
  at += 21_000;
  assert.equal(live.snapshot('bsc').rows[0].auditEligible, false, 'qualification history must not extend quote expiry');
  assert.equal(live.snapshot('bsc').rows[0].qualifiedAt, firstQualifiedAt);
  for (const nextMode of ['ready', 'pending', 'excluded', 'absent', 'ready']) {
    at += 20_000; mode = nextMode; snapshot = await live.readSnapshot('bsc');
    if (['excluded', 'absent'].includes(mode)) assert.equal(snapshot.rows.length, 0);
    else {
      assert.equal(snapshot.rows[0].qualifiedAt, firstQualifiedAt);
      assert.equal(snapshot.rows[0].firstSeenAt, now);
      assert.equal(snapshot.rows[0].newAt, 0);
    }
  }
  assert.equal(snapshot.rows[0].deltaWindowMs, null, 'identity history must not revive old quote comparisons');
  provider.keyEpoch++;
  assert.equal(live.snapshot('bsc').rows.length, 0);
  snapshot = await live.readSnapshot('bsc');
  assert.equal(snapshot.rows[0].qualifiedAt, firstQualifiedAt, 'credential refresh cannot create another first qualification');
  const remembered = [...live.identityHistory.get('bsc').values()][0];
  assert.equal(remembered.price, undefined);
  assert.equal(remembered.sourceUpdatedAt, undefined);
});

test('untrusted qualification timestamps cannot turn incomplete or stale observations into new candidates', () => {
  const pending = normalizeLiveRows([token(1, { volume_5m: null, qualifiedAt: now })], 'bsc', [], now);
  assert.equal(pending[0].qualifiedAt, null);
  const stale = normalizeLiveRows([token(1, { capturedAt: now - 120_000, sourceUpdatedAt: now - 120_000,
    expiresAt: now - 90_000, qualifiedAt: now })], 'bsc', [], now);
  assert.equal(stale[0].qualifiedAt, null);
  assert.equal(stale[0].auditEligible, false);
});

test('visible-client leases share one in-flight request and one global cadence across chains', async () => {
  let clock=now,calls=0,finish;
  const provider={keyEpoch:0,configured:async()=>true,live:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const live=new LiveDiscovery({...options(provider),now:()=>clock});
  live.touch('bsc');const pending=live.poll();await new Promise(resolve=>setImmediate(resolve));
  live.touch('bsc');live.touch('sol');await live.poll();assert.equal(calls,1);
  finish({tokens:[token()]});await pending;
  assert.equal(live.snapshot('sol').rows.length,0);assert.equal(live.snapshot('bsc').rows.length,1);
  clock+=10000;await live.poll();assert.equal(calls,1);
  clock+=21000;await live.poll();assert.equal(calls,1,'expired hidden-page lease must not fetch');
});

test('global rate-limit cooldown is honored; failed responses preserve old timestamps and stale flags', async () => {
  let clock=now,calls=0;
  const provider={keyEpoch:0,nextAllowedAt:now+60000,configured:async()=>true,live:async()=>{calls++;return {tokens:[token(1,{capturedAt:clock,sourceUpdatedAt:clock,expiresAt:clock+30000})]};}};
  const live=new LiveDiscovery({...options(provider),now:()=>clock});
  live.touch('bsc');await live.poll();assert.equal(calls,0);assert.equal(live.snapshot('bsc').status,'RATE_LIMITED');
  clock+=61000;live.touch('bsc');await live.poll();assert.equal(calls,1);
  const success=live.snapshot('bsc').lastSuccessAt;
  provider.live=async()=>{throw new Error('secret upstream failure');};clock+=65000;live.touch('bsc');await live.poll();
  assert.equal(live.snapshot('bsc').lastSuccessAt,success);assert.equal(live.snapshot('bsc').stale,true);
  assert.doesNotMatch(JSON.stringify(live.snapshot('bsc')),/secret upstream/);
});

test('AVE live cards apply one batch market overlay before filtering and expose real pool values', async () => {
  const ca = token().address, pool = '0x' + 'a'.repeat(40);
  const raw = { address: ca, chain: 'bsc', symbol: 'FAST', name: 'Fast', marketProvider: 'AVE', market_cap: 50_000,
    price: 1, holder_count: 10, capturedAt: now - 120_000, sourceUpdatedAt: now - 120_000,
    marketCapSourceUpdatedAt: now - 120_000, marketCapCapturedAt: now - 120_000, marketCapExpiresAt: now - 90_000,
    expiresAt: now - 90_000, stale: true };
  let overlayCalls = 0;
  const marketOverlay = { enrich: async (chain, rows, scope) => {
    overlayCalls++;
    assert.equal(chain, 'bsc'); assert.equal(scope.minMarketCap, config.discoveryMinMarketCap);
    return rows.map(row => ({ ...row, price: 1.1, market_cap: 51_000, liquidity: 12_000, volume_5m: 650,
      pool_created_at: now / 1000 - 900, pairAddress: pool, ageBasis: 'pool', capturedAt: now, sourceUpdatedAt: now,
      expiresAt: now + 20_000, marketCapSourceUpdatedAt: now, marketCapCapturedAt: now, marketCapExpiresAt: now + 20_000,
      stale: false, marketOverlayProvider: 'DEXSCREENER' }));
  } };
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ tokens: [raw], capturedAt: now - 120_000 }),
    snapshot: () => ({ pauseCode: null }), disabled: false, nextAllowedAt: 0 };
  const live = new LiveDiscovery({ provider, cacheOnly: true, marketOverlay, now: () => now,
    schedule: () => ({ unref() {} }), cancel: () => {} });
  const snapshot = await live.readSnapshot('bsc');
  assert.equal(overlayCalls, 1);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].liquidity, 12_000);
  assert.equal(snapshot.rows[0].volume5m, 650);
  assert.equal(snapshot.rows[0].createdAt, now / 1000 - 900);
  assert.equal(snapshot.rows[0].auditEligible, true);
});

test('local HTTP returns the AVE cache within the short wait even when the overlay never settles', async t => {
  const at = Date.now(); let overlayCalls = 0;
  const raw = token(1, { volume_5m: null, capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 30_000,
    launch_at: Math.floor(at / 1000) - 900 });
  const provider = { keyEpoch: 0, configured: async () => true, live: async (_chain, request) => {
    assert.equal(request.refresh, false); return { tokens: [raw], capturedAt: at };
  } };
  const live = new LiveDiscovery({ ...options(provider), now: Date.now, cacheOnly: true,
    marketOverlay: { enrich: () => { overlayCalls++; return new Promise(() => {}); } } });
  t.after(() => live.stop());
  const server = createServer({ state: { value: { activeChain: 'bsc', candidates: [], auditQueue: [] } }, liveDiscovery: live, settings: config });
  const started = performance.now();
  const response = await dispatch(server, '/api/live-discovery', { chain: 'bsc' });
  assert.ok(performance.now() - started < 1_000, 'local HTTP must not wait for the external eight-second timeout');
  assert.equal(response.status, 200);
  assert.equal(response.body.rows.length, 0, 'missing volume cannot become a READY candidate while enrichment is pending');
  assert.equal(live.snapshot('bsc').rows[0].qualifiedAt, null);
  assert.equal(live.snapshot('bsc').rows[0].sourceUpdatedAt, at);
  assert.equal(overlayCalls, 1);
});

test('HTTP readers and the passive poll share one per-chain cache read and background enrichment', async t => {
  let reads = 0, calls = 0; const pending = deferred(), raw = token();
  const provider = { keyEpoch: 0, configured: async () => true, live: async (_chain, request) => {
    reads++; assert.equal(request.refresh, false); return { tokens: [raw], capturedAt: now };
  } };
  const live = new LiveDiscovery({ ...options(provider), cacheOnly: true, overlayWaitMs: 5,
    marketOverlay: { enrich: () => { calls++; return pending.promise; } } });
  t.after(() => live.stop());
  const first = live.readSnapshot('bsc'), second = live.readSnapshot('bsc'), poll = live.poll();
  const results = await Promise.all([first, second, poll]);
  assert.equal(reads, 1); assert.equal(calls, 1);
  assert.equal(results[0].rows[0].marketCap, 50_000);
  pending.resolve([overlayRow(raw, now)]); await flushBackground();
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 51_000);
  assert.equal((await live.readSnapshot('bsc')).rows[0].marketCap, 51_000);
  assert.equal(calls, 1, 'passive refreshes reuse the completed enrichment during its cadence');
});

test('slow enrichment on one chain cannot hold another chain or publish into its snapshot', async t => {
  const jobs = new Map(), calls = [];
  const provider = { keyEpoch: 0, configured: async () => true,
    live: async chain => ({ tokens: [token(1, { chain, address: chain === 'sol' ? SOL_ADDRESS : '0x' + '1'.repeat(40) })], capturedAt: now }) };
  const live = new LiveDiscovery({ ...options(provider), cacheOnly: true, overlayWaitMs: 0,
    marketOverlay: { enrich: (chain, rows) => { calls.push(chain); const job = deferred(); jobs.set(chain, { ...job, row: rows[0] }); return job.promise; } } });
  t.after(() => live.stop());
  await Promise.all([live.readSnapshot('bsc'), live.readSnapshot('sol')]);
  assert.deepEqual(calls.sort(), ['bsc', 'sol']);
  jobs.get('sol').resolve([overlayRow(jobs.get('sol').row, now, { market_cap: 52_000 })]); await flushBackground();
  assert.equal(live.snapshot('sol').rows[0].marketCap, 52_000);
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 50_000);
  jobs.get('bsc').resolve([overlayRow(jobs.get('bsc').row, now, { market_cap: 53_000 })]); await flushBackground();
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 53_000);
  assert.equal(live.snapshot('sol').rows[0].marketCap, 52_000);
});

test('a late overlay for an old cache input cannot replace the newer page, and retries stay rate bounded', async t => {
  let at = now, id = 1; const jobs = [];
  const provider = { keyEpoch: 0, configured: async () => true,
    live: async () => ({ tokens: [token(id, { capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 30_000 })], capturedAt: at }) };
  const live = new LiveDiscovery({ ...options(provider), now: () => at, cacheOnly: true, overlayWaitMs: 0,
    marketOverlay: { enrich: (_chain, rows) => { const job = deferred(); jobs.push({ ...job, row: rows[0] }); return job.promise; } } });
  t.after(() => live.stop());
  await live.readSnapshot('bsc');
  id = 2; at += 5_000; await live.readSnapshot('bsc');
  jobs[0].resolve([overlayRow(jobs[0].row, at, { market_cap: 99_000 })]); await flushBackground();
  assert.equal(live.snapshot('bsc').rows[0].address, token(2).address);
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 50_000);
  await live.readSnapshot('bsc'); assert.equal(jobs.length, 1);
  at = now + 20_000; await live.readSnapshot('bsc');
  assert.equal(jobs.length, 2);
  jobs[1].resolve([overlayRow(jobs[1].row, at)]); await flushBackground();
  assert.equal(live.snapshot('bsc').rows[0].address, token(2).address);
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 51_000);
});

test('a derived AVE stale transition keeps a still-fresh DEX overlay but real risk changes invalidate it', async t => {
  let at = now, calls = 0, hazard = false;
  const raw = token(1, { volume_5m: null, expiresAt: now + 30_000 });
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ capturedAt: now,
    tokens: [{ ...raw, stale: at >= raw.expiresAt, ...(hazard ? { is_honeypot: 1 } : {}) }] }) };
  const live = new LiveDiscovery({ ...options(provider), now: () => at, cacheOnly: true, overlayWaitMs: 5,
    marketOverlay: { enrich: async (_chain, rows) => { calls++; return rows.map(row => overlayRow(row, at)); } } });
  t.after(() => live.stop());
  assert.equal((await live.readSnapshot('bsc')).rows[0].discoveryState, 'READY');
  at += 20_000;
  assert.equal((await live.readSnapshot('bsc')).rows[0].sourceUpdatedAt, now + 20_000);
  at += 10_000;
  const current = (await live.readSnapshot('bsc')).rows[0];
  assert.equal(current.discoveryState, 'READY'); assert.equal(current.auditEligible, true);
  assert.equal(current.sourceUpdatedAt, now + 20_000); assert.equal(current.expiresAt, now + 40_000);
  assert.equal(current.qualifiedAt, now); assert.equal(calls, 2);
  assert.equal(live.cachedInputs.get('bsc').tokens[0].stale, true, 'raw fallback still reflects actual AVE expiry');
  hazard = true; at += 1_000;
  assert.equal((await live.readSnapshot('bsc')).rows.length, 0, 'new adverse facts cannot borrow the prior overlay');
  assert.equal(calls, 2, 'source changes cannot bypass the request cadence');
});

test('credential changes, disconnects and stop invalidate late background publication', async t => {
  for (const action of ['epoch', 'disconnect', 'stop']) {
    let configured = true, id = 1; const jobs = [];
    const provider = { keyEpoch: 0, disabled: false, configured: async () => configured,
      live: async () => ({ tokens: [token(id)], capturedAt: now }) };
    const live = new LiveDiscovery({ ...options(provider), cacheOnly: true, overlayWaitMs: 0,
      marketOverlay: { enrich: (_chain, rows) => { const job = deferred(); jobs.push({ ...job, row: rows[0] }); return job.promise; } } });
    t.after(() => live.stop()); await live.readSnapshot('bsc');
    if (action === 'epoch') { provider.keyEpoch++; id = 2; await live.readSnapshot('bsc'); }
    if (action === 'disconnect') { configured = false; provider.disabled = true; await live.readSnapshot('bsc'); }
    if (action === 'stop') live.stop();
    jobs[0].resolve([overlayRow(jobs[0].row, now, { market_cap: 99_000 })]); await flushBackground();
    assert.equal(live.snapshot('bsc').rows[0].marketCap, 50_000);
    assert.equal(live.overlayJobs.has('bsc'), action === 'epoch');
    if (action === 'epoch') {
      assert.equal(live.snapshot('bsc').rows[0].address, token(2).address);
      jobs[1].resolve([overlayRow(jobs[1].row, now)]); await flushBackground();
      assert.equal(live.snapshot('bsc').rows[0].marketCap, 51_000);
    }
    if (action === 'disconnect') assert.equal(live.snapshot('bsc').status, 'AUTH_REQUIRED');
  }
});

test('a rejecting dependency is caught and cannot create a new external request every five-second UI refresh', async t => {
  let at = now, calls = 0;
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ tokens: [token()], capturedAt: now }) };
  const live = new LiveDiscovery({ ...options(provider), now: () => at, cacheOnly: true, overlayWaitMs: 5,
    marketOverlay: { enrich: async () => { calls++; throw new Error('upstream private failure'); } } });
  t.after(() => live.stop());
  for (const offset of [0, 5_000, 10_000, 15_000]) {
    at = now + offset; const snapshot = await live.readSnapshot('bsc');
    assert.equal(snapshot.status, 'READY'); assert.doesNotMatch(JSON.stringify(snapshot), /private failure/);
  }
  assert.equal(calls, 1);
  at += 5_000; await live.readSnapshot('bsc'); assert.equal(calls, 2);
});

test('the background deadline releases a stuck task and its later resolution cannot overwrite a retry', async t => {
  let at = now; const jobs = [];
  const provider = { keyEpoch: 0, configured: async () => true,
    live: async () => ({ tokens: [token(1, { capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 30_000 })], capturedAt: at }) };
  const live = new LiveDiscovery({ ...options(provider), now: () => at, cacheOnly: true, overlayWaitMs: 0, overlayTimeoutMs: 5,
    marketOverlay: { enrich: (_chain, rows) => { const job = deferred(); jobs.push({ ...job, row: rows[0] }); return job.promise; } } });
  t.after(() => live.stop()); await live.readSnapshot('bsc');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(live.overlayJobs.size, 0);
  at += 5_000; await live.readSnapshot('bsc'); assert.equal(jobs.length, 1);
  at = now + 20_000; await live.readSnapshot('bsc'); assert.equal(jobs.length, 2);
  jobs[1].resolve([overlayRow(jobs[1].row, at)]); await flushBackground();
  jobs[0].resolve([overlayRow(jobs[0].row, at, { market_cap: 99_000 })]); await flushBackground();
  assert.equal(live.snapshot('bsc').rows[0].marketCap, 51_000);
});

test('late or reused enrichment never extends evidence expiry or manufactures first qualification', async t => {
  let at = now; const pending = deferred(), raw = token(1, { volume_5m: null });
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ tokens: [raw], capturedAt: now }) };
  const live = new LiveDiscovery({ ...options(provider), now: () => at, cacheOnly: true, overlayWaitMs: 0,
    marketOverlay: { enrich: () => pending.promise } });
  t.after(() => live.stop()); await live.readSnapshot('bsc');
  at += 31_000; pending.resolve([overlayRow(raw, now)]); await flushBackground();
  const stale = live.snapshot('bsc').rows[0];
  assert.equal(stale.sourceUpdatedAt, now); assert.equal(stale.expiresAt, now + 30_000);
  assert.equal(stale.auditEligible, false); assert.equal(stale.qualifiedAt, null);
  assert.equal((await live.readSnapshot('bsc')).rows[0].auditEligible, false);
});

test('credential changes discard in-flight data; unconfigured feed never requests upstream', async () => {
  let finish,calls=0;
  const provider={keyEpoch:0,configured:async()=>false,live:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const live=new LiveDiscovery(options(provider));live.touch('bsc');await live.poll();assert.equal(calls,0);
  provider.configured=async()=>true;live.nextPollAt=0;
  const pending=live.poll();await new Promise(resolve=>setImmediate(resolve));
  provider.disabled=true;provider.keyEpoch++;finish({tokens:[token()]});await pending;
  assert.equal(live.snapshot('bsc').rows.length,0);assert.equal(live.auditRow('bsc',token().address),null);
});

test('malformed successful payloads are errors, not fake empty live updates; audit input has no mislabeled 1m counters', async () => {
  const provider={keyEpoch:0,configured:async()=>true,live:async()=>({tokens:[token()]})};
  const live=new LiveDiscovery(options(provider));live.touch('bsc');await live.poll();
  const audit=live.auditRow('bsc',token().address);
  assert.equal(audit.volume,undefined);assert.equal(audit.buys,undefined);assert.equal(audit.swaps,undefined);
  live.nextPollAt=0;provider.live=async()=>({unexpected:true});await live.poll();
  assert.equal(live.snapshot('bsc').status,'ERROR');assert.equal(live.snapshot('bsc').pollCount,1);
});

test('manual review uses original safety gates, one priority slot, unchanged batch budget and no chain switch', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-live-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state=new RadarState(dir);state.value.activeChain='bsc';const audited=[];
  const fresh=id=>{const at=Date.now();return token(id,{launch_at:Math.floor(at/1000)-1000,capturedAt:at,sourceUpdatedAt:at,expiresAt:at+30000});};
  const provider={keyEpoch:0,configured:async()=>true,discover:async()=>[fresh(1),fresh(2),fresh(3)],audit:async address=>{audited.push(address);
    return {info:{price:{price:1}},security:{owner_renounced:'no'},pool:{},holders:[],traders:[],candles:[],_meta:{provider:'AVE',complete:false,transportComplete:true}};}};
  const scanner=new Scanner({provider,state,settings:{...config,maxDeepAuditsPerCycle:2}});
  assert.equal(scanner.enqueueReview('sol',fresh(4)).reason,'chain_not_scanning');
  assert.equal(scanner.enqueueReview('bsc',{...fresh(4),is_honeypot:1}).accepted,false);
  assert.equal(scanner.enqueueReview('bsc',fresh(4)).accepted,true);
  assert.equal(scanner.enqueueReview('bsc',fresh(4)).accepted,true);
  await scanner.cycle();assert.equal(audited.length,2);assert.equal(audited[0],fresh(4).address);
  assert.equal(scanner.activeChain,'bsc');assert.equal(scanner.requestedReviews.size,0);
});

function dispatch(server,route,body,origin=true) {
  return new Promise((resolve,reject)=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.url=route;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'127.0.0.1:3791','content-type':'application/json',...(origin?{origin:'http://127.0.0.1:3791'}:{})};
    const res={writeHead(status){this.status=status;},end(body){resolve({status:this.status,body:JSON.parse(body)});}};
    Promise.resolve(server.listeners('request')[0](req,res)).catch(reject);
  });
}

test('live endpoints require same-origin exact schema and return no raw data or trade authority', async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  let touches=0,queued=0;
  const live={touch:chain=>{touches++;return {chain,rows:[{address}],execution:false};},auditRow:()=>token()};
  const server=createServer({state:{value:{activeChain:'bsc',candidates:[{address,status:'HARD_REJECT',auditedAt:now,raw:'secret'}]}},settings:{...config,maxDeepAuditsPerCycle:1,publicDir:path.join(root,'public')},
    liveDiscovery:live,enqueueReview:()=>{queued++;return {accepted:true};}});
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'bsc'},false)).status,403);
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'bsc',force:true})).status,400);
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'unknown'})).status,400);
  const response=await dispatch(server,'/api/live-discovery',{chain:'bsc'});
  assert.equal(touches,1);assert.equal(response.body.execution,false);assert.equal(response.body.rows.length,0);
  assert.equal(response.body.diagnostics.excluded,1);
  assert.doesNotMatch(JSON.stringify(response),/secret/);
  assert.equal((await dispatch(server,'/api/live-review',{chain:'bsc',address})).status,200);assert.equal(queued,1);
});
