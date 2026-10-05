#!/usr/bin/env node
import { config, ROOT } from './config.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GmgnRadarSource } from './gmgn-radar.mjs';
import { RadarState } from './state.mjs';
import { Scanner } from './scanner.mjs';
import { DexBatchMarketOverlay, SecondaryValidator } from './secondary.mjs';
import { GoPlusReader } from './goplus.mjs';
import { createServer, toPublicStatus } from './server.mjs';
import { RadarControls } from './local-store.mjs';
import { LiveDiscovery } from './live-discovery.mjs';
import { createGmgnDiscovery } from './gmgn-discovery.mjs';
import { configureWindowsSystemProxy } from './windows-proxy.mjs';

// Windows portable supervisor bridge: keep the packaged EXE launcher intact.
const once = process.argv.includes('--once');
if (process.platform === 'win32' && !once && process.env.RADAR_SUPERVISED !== '1'
  && resolve(process.execPath).toLowerCase() === resolve(ROOT, 'runtime', 'node.exe').toLowerCase()) {
  try {
    const { superviseRadar } = await import('../scripts/supervise.mjs');
    await superviseRadar();
    process.exit(0);
  } catch (error) {
    console.error('守护启动未完成：' + error.message);
    process.exit(1);
  }
}

// Browsers use the Windows system proxy automatically, while Node normally
// only sees proxy environment variables. Mirror the effective Windows proxy
// before AVE reads begin so the portable build follows the same
// network route as the user's browser.
const proxy = configureWindowsSystemProxy();
if (process.platform === 'win32') {
  console.log(proxy.proxy ? '已接入 Windows 系统网络代理。' : '未检测到 Windows 系统代理，将使用直连网络。');
}

const state = new RadarState(config.stateDir);
let scanner;
// Production discovery performs one read per route per turn. Neither route
// answers a windowed volume counter, and neither paginates, so a single sample
// per cycle is the whole budget - and it is spent on the only ordering that
// returns pools young enough to matter.
const sharedRequestIntervalMs = 5 * 60_000;
// GMGN is the only discovery source. AVE is retired: it paced itself by
// sleeping inside its request lane - `lane.nextStart` was `now + spacing()`,
// and `spacing` had climbed to its fifteen-minute ceiling - so one discovery
// read could hold an entire scan cycle open. Measured 2026-10-04: `lastCycleMs`
// 903544 against a previous cycle of 2645 ms, with `scanInProgress` stuck true
// and the outcome read-back never reached.
const market = new GmgnRadarSource({ settings: config, chains: config.supportedChains });
// Keep old history on disk, but never reuse a previous provider's pass or an
// unlabelled baseline as current evidence. Baselines already priced are left
// exactly as they are - a row is never re-labelled to make it measurable, and
// the rows this source cannot read back are counted rather than dropped.
if (state.value.scanProvider !== 'GMGN') {
  for (const scope of [state.value, ...Object.values(state.value.chainStates || {})]) {
    for (const row of scope.outcomes || []) row.baselineProvider ||= 'LEGACY_UNKNOWN';
    for (const row of scope.candidates || []) {
      row.marketProvider ||= 'LEGACY_UNKNOWN';
      if (row.status === 'X_REVIEW') {
        row.status = 'WAIT_RECHECK'; row.staleAt = 0;
        row.deep = { ...row.deep, chainPass: false };
        row.decisionReason = '已切换发现来源，等待新来源核验';
      }
    }
    scope.sourceHealth = {}; scope.retryAt = 0;
  }
  state.value.scanProvider = 'GMGN'; state.save();
}
const controls = new RadarControls(config.stateDir, config.supportedChains, state.value.activeChain || config.chain);
// The signal channel: wallet clusters from the smart-money and KOL trade feeds.
// It builds only when a key is present, so a stock install is unchanged.
// Declared before the scanner because the scanner is handed it as its second
// tracking source below.
const signals = createGmgnDiscovery({ settings: config, chains: config.supportedChains });
scanner = new Scanner({ provider: market,
  secondary: new SecondaryValidator(),
  // Optional enrichment for the tracking board: holder concentration and a
  // contract verdict, neither of which is a market reading. A failure here must
  // never be able to fail a scan, so the reader degrades to null throughout.
  goplus: config.goplusLookupsPerCycle > 0
    ? new GoPlusReader({ timeoutMs: config.goplusTimeoutMs, cacheMs: config.goplusCacheMs, maxPerCycle: config.goplusLookupsPerCycle })
    : null,
  state, controls, sharedRequestIntervalMs,
  // The tracking board's second source. The discovery routes report a pool's
  // market facts but not the wallets behind it, so without this channel the
  // board would be blind to the clusters that only the trade feed can see.
  feed: signals,
  // Read-back is answered by the same provider that supplies discovery, which
  // is also the provider that priced every baseline this build writes. One
  // curve, one ruler.
  outcomeProvider: market.client, outcomeProviderName: 'GMGN'
});
// The page's radar reads the scanner's cache and never pays for a read of its
// own; the source refreshes itself on its own clock inside that read.
const liveDiscovery = new LiveDiscovery({ provider: market, cacheOnly: true, marketOverlay: new DexBatchMarketOverlay() });
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (once) {
  await scanner.cycle();
  console.log(JSON.stringify(toPublicStatus(state.value), null, 2));
  process.exit(state.value.status === 'ERROR' ? 1 : 0);
}

const server = createServer({
  state,
  controls,
  liveDiscovery,
  signals,
  enqueueReview: (chain, row) => scanner.enqueueReview(chain, row),
  settings: { ...config, version },
  supportedChains: config.supportedChains,
  switchChain: chain => scanner.switchChain(chain),
  getSchedulerStatus: chain => scanner.scheduleSnapshot(chain),
  getMarketStatus: () => market.snapshot()
});
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  // Bind the unspecified address (dual-stack on IPv6-capable hosts) so both
  // `localhost` (::1) and `127.0.0.1` resolve. Non-loopback peers are still
  // rejected per-request by isTrustedLocalRequest() in server.mjs.
  server.listen(config.port, resolve);
});
console.log(`Meme雷达：http://127.0.0.1:${config.port}  （或 http://localhost:${config.port}）`);
console.log('只读扫描器：交易执行永久关闭');
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true; scanner.stop(); liveDiscovery.stop(); signals?.stop();
  market.resetCredentials();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
await scanner.start();
signals?.start();
