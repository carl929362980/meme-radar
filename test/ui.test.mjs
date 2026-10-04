import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

function liveRefreshHarness(fetch) {
  const previous = { chain: 'bsc', rows: [{ symbol: 'PREVIOUS' }] };
  const context = { fetch, AbortSignal, document: { hidden: false },
    renderLive() {}, activeChain: data => data.activeChain,
    liveEnabled: true, liveBusy: false, serviceOnline: true, liveRefreshErrorChain: '',
    lastData: { activeChain: 'bsc' }, viewChain: 'bsc', liveData: previous };
  const start = html.indexOf('async function refreshLive()'), end = html.indexOf('function render(data, forceCandidates)', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end), context);
  return { context, previous };
}

test('candidate timeout, HTTP and payload failures preserve data and do not mark a healthy local service offline', async () => {
  const failures = [
    async () => { throw new DOMException('timed out', 'TimeoutError'); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid json'); } }),
    async () => ({ ok: true, json: async () => ({ chain: 'sol', rows: [] }) }),
    async () => ({ ok: true, json: async () => ({ chain: 'bsc', rows: null }) }),
  ];
  for (const fetch of failures) {
    const { context, previous } = liveRefreshHarness(fetch);
    await context.refreshLive();
    assert.equal(context.liveRefreshErrorChain, 'bsc');
    assert.equal(context.serviceOnline, true);
    assert.equal(context.liveData, previous);
    assert.equal(context.liveBusy, false);
    const recovered = { chain: 'bsc', rows: [{ symbol: 'RECOVERED' }] };
    context.fetch = async () => ({ ok: true, json: async () => recovered });
    await context.refreshLive();
    assert.equal(context.liveRefreshErrorChain, '');
    assert.equal(context.liveData, recovered);
  }
});

test('an old-chain response or timeout cannot overwrite the newly selected chain or its connection state', async () => {
  for (const fail of [false, true]) {
    let settle;
    const { context } = liveRefreshHarness(() => new Promise((resolve, reject) => {
      settle = () => fail ? reject(new Error('old chain timeout'))
        : resolve({ ok: true, json: async () => ({ chain: 'bsc', rows: [] }) });
    }));
    const pending = context.refreshLive();
    context.viewChain = 'sol';
    const selected = { chain: 'sol', rows: [{ symbol: 'SOL' }] };
    context.liveData = selected;
    settle();
    await pending;
    assert.equal(context.liveData, selected);
    assert.equal(context.liveRefreshErrorChain, '');
    assert.equal(context.serviceOnline, true);
    assert.equal(context.liveBusy, false);
  }
});

// The radar's rows reach the board through unifiedPoolRows. The market source
// in use publishes no expiry clock at all - `expiresAt` is null on every row -
// so a freshness test written as `expiresAt > now` dropped all of them: the API
// answered 31 rows and the board drew one. An absent expiry is not an expired
// one; the reading's own age is what is left to test.
test('缺失到期时间的行情行仍然进入看板，缺失不是过期', () => {
  const start = html.indexOf('function unifiedPoolRows('), end = html.indexOf('function renderTrack(', start);
  assert.ok(start >= 0 && end > start);
  const at = Date.now();
  const row = (index, over = {}) => ({ chain: 'bsc', address: '0x' + String(index + 1).padStart(40, 'a'), symbol: 'T' + index,
    marketProvider: 'GMGN', discoveryState: 'READY', auditEligible: true, stale: false,
    firstSeenAt: at - 5_000, sourceUpdatedAt: at - 5_000, expiresAt: null, ...over });
  const context = { Date, Math, Number, Object, Array, String, JSON, Infinity,
    byId: () => ({ innerHTML: '', textContent: '', hidden: false, className: '', checked: false, dataset: {}, value: '' }),
    number: value => Number(value) || 0, t: key => key, rowsCache: [], viewChain: 'bsc',
    activeChain: data => data && data.activeChain, backendDisposition: () => '', addressIdentity: value => String(value),
    voiceSpotlightRank: () => Infinity, voiceSpotlightSnapshot: null,
    liveData: { chain: 'bsc', rows: [row(1), row(2), { ...row(3), expiresAt: at - 1000 }, { ...row(4), sourceUpdatedAt: at - 120_000 }] } };
  vm.runInNewContext(html.slice(start, end) + ';this.unified=unifiedPoolRows;', context);
  const kept = context.unified('bsc').map(item => item.address);
  assert.equal(kept.length, 2, 'two fresh rows with no expiry clock are still on the board');
  assert.ok(kept.includes(context.liveData.rows[0].address) && kept.includes(context.liveData.rows[1].address));
  assert.equal(kept.includes(context.liveData.rows[2].address), false, 'a real past expiry still expires');
  assert.equal(kept.includes(context.liveData.rows[3].address), false, 'a reading older than a minute is still stale');
});

test('performance and event panels are removed together with their render hooks; scan status and voice remain', () => {
  assert.doesNotMatch(html, /data-i18n="(?:outcomeTitle|eventsTitle)"/);
  assert.doesNotMatch(html, /id="(?:outcome[^\"]*|events|cycle|requestSummary|eventHistory[^\"]*)"/);
  assert.doesNotMatch(html, /\b(?:eventOverview|renderEvents|renderOutcomes)\s*\(/);
  // The candidate radar is not a panel of its own any more: its rows are handed
  // to the board's renderer, so the page carries exactly one board section.
  assert.match(html, /id="trackPanel"/);
  assert.doesNotMatch(html, /id="livePanel"/);
  assert.match(html, /id="voiceEnable"/);
  assert.match(html, /id="providerState"/);
  assert.match(html, /renderTelemetry\(\)/);
  assert.match(html, /renderLive\(\)/);
});

// AVE is retired. The card now opens a neutral public chart: no referral, no
// order route, and the pool or source URL a row arrives with is never
// substituted into the link.
test('卡片只打开公共行情页，不替换池子或来源，也不带推广参数', () => {
  const start = html.indexOf('const EXPLORER_SLUGS =');
  const end = html.indexOf('function candidateRow', start);
  const context = { t: key => key, encodeURIComponent,
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    safeUrl: () => '', officialXHandle: () => '' };
  vm.runInNewContext(html.slice(start, end) + ';this.links = actionLinks;this.tokenUrl = explorerUrl;', context);
  const sol = 'So11111111111111111111111111111111111111112';
  const evm = '0x059ecb64e45b6211f1390d5f28cc909203ca7777';
  for (const [chain, address, slug] of [['sol', sol, 'solana'], ['bsc', evm, 'bsc'], ['ethereum', evm, 'ethereum']]) {
    const links = context.links({ chain, address, pairAddress: 'wrong-pool', gmgnUrl: 'https://gmgn.ai/override' });
    assert.ok(links.includes('https://dexscreener.com/' + slug + '/' + address), chain + ' 应打开公共行情页');
    assert.doesNotMatch(links, /wrong-pool/, chain + ' 的池子不得进入链接');
    assert.doesNotMatch(links, /[?&]ref=/, '链接不带推广参数');
    assert.match(links, /data-action="copy"/);
    assert.match(links, /noopener noreferrer/);
  }
  // 未知链或非法地址：不给链接，回落到公共站点首页，而不是指向某个别的池子。
  for (const row of [{ chain: 'unknown', address: evm }, { chain: 'robinhood', address: evm },
    { chain: 'bsc', address: 'not-a-ca' }, { chain: 'bsc', address: evm + '?ref=evil' }]) {
    assert.equal(context.tokenUrl(row.chain, row.address), null);
    assert.match(context.links(row), /href="https:\/\/dexscreener\.com"/);
  }
  assert.doesNotMatch(html, /ave\.ai|AVE_INVITE_URL|aveTokenUrl/);
});

test('所有内联脚本均可通过语法解析', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('所有显式像素字号均不小于14像素', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 14));
});

test('看板明确区分累计、本轮和近30分钟口径', () => {
  assert.match(html, /<h1[^>]*>Meme雷达开源版<\/h1>/);
  assert.match(html, /class="mark">雷达<\/div>/);
  assert.match(html, /扫描轮次[\s\S]*累计/);
  assert.match(html, /发现代币[\s\S]*本轮/);
  assert.match(html, /深度审计[\s\S]*近30分钟/);
  assert.match(html, /链上候选\/待人工看X/);
  assert.doesNotMatch(html, /最终候选/);
});

test('自动筛选替代人工通过，保留历史标记兼容且不下单', () => {
  assert.match(html, /robinhoodRadarManualMarksV1/);
  assert.doesNotMatch(html, /data-action="pass"/);
  assert.doesNotMatch(html, /data-action="ignore"/);
  assert.match(html, /id="advancedPanel"[^>]*>/);
  assert.doesNotMatch(html, /id="advancedPanel"[^>]*\bopen\b/);
  // The radar's "newest first" select went with the radar panel; the one board
  // sorts by the engine's grade by default.
  assert.match(html, /value="grade" selected/);
  assert.match(html, /class="compact-audits"/);
  assert.match(html, /复制合约/);
  assert.match(html, /官网无/);
  assert.match(html, /访问官网/);
  assert.match(html, /safeUrl\(row\.info && row\.info\.website\)/);
  assert.match(html, /officialXHandle/);
  assert.match(html, /normalizeXHandle/);
  assert.match(html, /reservedXPaths/);
  assert.match(html, /普通钱包代理数量未知/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /只扫描、不交易/);
});

test('前端X入口拒绝站内功能页并只生成单层用户名链接', () => {
  const start = html.indexOf('const reservedXPaths = new Set(');
  const end = html.indexOf('function officialXHandle', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.runInNewContext(html.slice(start, end) + '\nthis.normalize = normalizeXHandle;', context);
  assert.equal(context.normalize('https://x.com/search?q=test'), '');
  assert.equal(context.normalize('https://x.com/home'), '');
  assert.equal(context.normalize('x.com/real_handle'), 'real_handle');
  assert.equal(context.normalize('@real_handle'), 'real_handle');
  assert.equal(context.normalize('https://example.com/x.com/fake'), '');
  assert.equal('https://x.com/' + encodeURIComponent(context.normalize('x.com/real_handle')), 'https://x.com/real_handle');
});

test('六语切换持久化并支持阿拉伯语RTL', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    assert.match(html, new RegExp('<option value="' + locale + '"'));
  }
  assert.match(html, /memeRadarLanguageV1/);
  assert.match(html, /document\.documentElement\.dir = currentLocale === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(html, /html\[dir="rtl"\]/);
  assert.match(html, /data-i18n="appTitle"/);
  assert.match(html, /data-i18n="auditTitle"/);
  assert.match(html, /t\(statusKeys\[data\.status\]/);
  assert.doesNotMatch(html, /GMGN多链候选雷达 · 只扫描、只筛选、永不下单/);
});

test('语言下拉使用地球图标和深色高对比选项', () => {
  assert.match(html, /class="language-icon" aria-hidden="true">🌐<\/span>/);
  assert.match(html, /class="visually-hidden" data-i18n="languageLabel">语言<\/span>/);
  assert.match(html, /\.language-select\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.language-select option\s*\{[\s\S]*?background:\s*#0b151a;[\s\S]*?color:\s*#f2faf8/);
  assert.match(html, /\.language-select:focus-visible\s*\{[\s\S]*?outline:\s*1px solid #61cbd4/);
  assert.doesNotMatch(html, /\.language-select\s*\{[\s\S]*?background:\s*transparent/);
});

test('语音播报提供独立的中英文手动切换，最近成功与限频状态分开显示', () => {
  assert.match(html, /id="voiceLanguage"[^>]*>[\s\S]*?<option value="zh">中文<\/option>[\s\S]*?<option value="en">English<\/option>/);
  assert.match(html, /memeRadarLastSuccessAtV2:/);
  assert.match(html, /recentSuccess/);
  assert.doesNotMatch(html, /robinhoodRadarLastSuccessAtV1/);
});

test('翻译词典完整覆盖静态挂点和动态文案键', () => {
  const dictionarySource = html.match(/const messages = (\{[\s\S]*?\n    \});\n\n    let currentLocale/);
  assert.ok(dictionarySource, '应能提取翻译词典');
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  for (const [key, values] of Object.entries(messages)) {
    assert.ok(Array.isArray(values), key + ' 应为数组');
    assert.equal(values.length, 6, key + ' 应包含六种语言');
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), key + ' 不应有空翻译');
  }
  const staticKeys = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]);
  const dynamicKeys = [...html.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const key of new Set([...staticKeys, ...dynamicKeys])) assert.ok(messages[key], '缺少翻译键：' + key);
});

test('顶部链标签可直接加入或切换扫描，且只呈现本版本支持的链', async () => {
  for (const chain of ['sol', 'bsc']) {
    assert.match(html, new RegExp("id: '" + chain + "'"));
  }
  assert.match(html, /renderChainSwitcher\(null\)/);
  const start = html.indexOf('function activeChain('), end = html.indexOf('function providerStatus(', start);
  assert.ok(start >= 0 && end > start);
  function harness(enabled, active = 'bsc', view = '') {
    const elements = { chainSwitcher: { innerHTML: '' }, chainHint: { textContent: '' } };
    const requests = [], storage = [], toasts = [];
    const context = {
      chainCatalog: ['sol', 'bsc'].map(id => ({ id })),
      chainSwitching: false, selectedChainsDirty: true, viewChain: view,
      lastData: { activeChain: active, supportedChains: ['sol', 'bsc'], scheduler: { enabledChains: enabled, scanningChain: active } },
      byId: id => elements[id], chainLabel: chain => chain.id, escapeHtml: String, t: key => key,
      showToast: value => toasts.push(value), currentLocale: 'en', hasChinese: () => false,
      postLocal: async (url, body) => { requests.push({ url, body }); return { enabledChains: body.chains }; },
      writeStorage: (key, value) => storage.push({ key, value }), refresh: async () => {}
    };
    vm.runInNewContext(html.slice(start, end) + ';this.renderChainSwitcher=renderChainSwitcher;this.switchActiveChain=switchActiveChain;this.ensureVisibleChain=ensureVisibleChain;', context);
    return { context, elements, requests, storage, toasts };
  }

  const adding = harness(['bsc']);
  adding.context.renderChainSwitcher(adding.context.lastData);
  for (const chain of ['sol', 'bsc']) {
    const button = adding.elements.chainSwitcher.innerHTML.match(new RegExp('<button[^>]*data-chain="' + chain + '"[^>]*>'))?.[0];
    assert.ok(button, chain + ' 应显示');
    assert.doesNotMatch(button, /\sdisabled(?:\s|>)/, chain + ' 应可点击');
    assert.match(button, new RegExp('title="' + (chain === 'bsc' ? 'chainPollingTitle' : 'chainJoinTitle') + '"'));
    assert.match(button, /aria-label=/);
  }
  assert.equal((adding.elements.chainSwitcher.innerHTML.match(/>chainPollingBadge<\/span>/g) || []).length, 1,
    'only enabled chains show a polling badge; selection is not evidence of health');
  adding.context.renderChainSwitcher(null);
  assert.doesNotMatch(adding.elements.chainSwitcher.innerHTML, /chainPollingBadge/);
  assert.match(adding.elements.chainSwitcher.innerHTML, /chainOfflineHint/);

  // 该链未在扫描集中：加入而不是替换，且不越出本版本支持的链。
  await adding.context.switchActiveChain('sol');
  assert.deepEqual(JSON.parse(JSON.stringify(adding.requests)), [{ url: '/api/scan-chains', body: { chains: ['bsc', 'sol'] } }]);
  assert.equal(adding.context.viewChain, 'sol');

  // 两链都已在扫描集：只切换视图，不再发请求。
  const viewing = harness(['bsc', 'sol'], 'bsc');
  await viewing.context.switchActiveChain('sol');
  assert.deepEqual(viewing.requests, []);
  assert.equal(viewing.context.viewChain, 'sol');

  // 视图链不在扫描集时，回落到正在扫描的链并持久化。
  const restored = harness(['bsc'], 'bsc', 'sol');
  assert.equal(restored.context.ensureVisibleChain(restored.context.lastData), true);
  assert.equal(restored.context.viewChain, 'bsc');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.storage)), [{ key: 'memeRadarViewChainV1', value: 'bsc' }]);
  assert.doesNotMatch(html.slice(start, end), /\/api\/active-chain/);
});

test('行情源健康状态使用短句，限频仍显示恢复时间', () => {
  const start = html.indexOf('function providerStatus('), end = html.indexOf('function freshnessStatus(', start);
  const now = Date.now();
  const context = { Date, activeChain: data => data.activeChain, formatClock: value => 'clock:' + value,
    t: (key, args) => args ? key + ':' + JSON.stringify(args) : key, number: Number, relativeTime: String };
  vm.runInNewContext(html.slice(start, end) + ';this.providerStatus=providerStatus;', context);
  const healthy = context.providerStatus({ activeChain: 'bsc', status: 'RUNNING',
    sourceHealth: { discovery: { trenches: { ok: true }, trending: { ok: true }, complete: true, checkedAt: now - 1000 } } });
  assert.equal(healthy.title, 'providerNormal');
  assert.match(healthy.detail, /providerDiscovery/);
  assert.doesNotMatch(healthy.detail, /liveLimits/);
  // A cooldown is only a cooldown while it has not elapsed; it must say when.
  const limited = context.providerStatus({ activeChain: 'bsc', status: 'RATE_LIMITED',
    market: { provider: 'GMGN', pauseCode: 'SOURCE_COOLING', nextAllowedAt: now + 60_000 } });
  assert.match(limited.detail, /apiRetryAt/);
  assert.match(limited.detail, /clock:/);
  const elapsed = context.providerStatus({ activeChain: 'bsc', status: 'RATE_LIMITED',
    market: { provider: 'GMGN', pauseCode: 'SOURCE_COOLING', nextAllowedAt: now - 1000 } });
  assert.doesNotMatch(elapsed.detail, /clock:/);
});

test('共享免费调度显示选中链的最早尝试，不把全局或空时间当每链倒计时', () => {
  const start = html.indexOf('function schedulePresentation('), end = html.indexOf('function renderScreening(', start);
  const context = { t: (key, args) => key + (args ? ':' + JSON.stringify(args) : ''), formatDuration: String };
  vm.runInNewContext(html.slice(start, end) + ';this.show=schedulePresentation;', context);
  const at = 1_800_000_000_000;
  const data = { nextCycleAt: at + 300000, scheduler: { scope: 'shared-provider', reason: 'shared_cadence',
    nextSharedAttemptAt: at + 300000, selectedNextAttemptAt: at + 900000 } };
  assert.match(context.show(data, at).title, /900000/);
  assert.equal(context.show(data, at).detail, 'attemptEstimate');
  data.scheduler.selectedNextAttemptAt = null;
  assert.equal(context.show(data, at).title, 'waitingSchedule');
  for (const [reason, title] of Object.entries({ disabled: 'scanDisabled', recovery_chain_deferred: 'chainDeferred',
    auth_required: 'scanNeedsAction', manual_reset_required: 'scanNeedsAction', scanning: 'statusScanning', stopped: 'waitingSchedule' })) {
    data.scheduler.reason = reason;
    assert.equal(context.show(data, at).title, title);
  }
  assert.equal(context.show({}, at), null, 'old snapshots keep a separate compatibility path');
});

test('筛选原因默认折叠，缺失统计不伪造零，行情初筛不标成安全审计', () => {
  const start = html.indexOf('function renderScreening('), end = html.indexOf('function renderTelemetry(', start);
  const elements = Object.fromEntries(['screeningDetails', 'screeningCounts', 'screeningChecked'].map(id => [id, {}]));
  const context = { byId: id => elements[id], number: value => Number(value) || 0, formatCount: String, formatClock: String,
    t: (key, args) => key + (args ? ':' + JSON.stringify(args) : '') };
  vm.runInNewContext(html.slice(start, end) + ';this.show=renderScreening;', context);
  context.show({}); assert.equal(elements.screeningDetails.hidden, true);
  context.show({ screening: { countsAvailable: true, received: 100, marketQualified: 2, filtered: 98,
    checkedAt: 1234, reasonCounts: { activity: 20, missing_market: 30, known_risk: 0 } } });
  assert.equal(elements.screeningDetails.hidden, false);
  assert.match(elements.screeningCounts.textContent, /filterMissing 30/);
  assert.match(elements.screeningCounts.textContent, /filterActivity 20/);
  assert.doesNotMatch(elements.screeningCounts.textContent, /filterRisk/);
  assert.match(elements.screeningChecked.textContent, /1234/);
  assert.match(html, /<details id="screeningDetails"[^>]*hidden>/);
  assert.doesNotMatch(html, /<details id="screeningDetails"[^>]*\bopen\b/);
  assert.match(html, /liveEligible: \['初筛 · 未核验'/);
  // 退役后只剩一个未授权状态：不再存在 AVE 专属码。
  assert.match(html, /data\.status === 'AUTH_REQUIRED'/);
  assert.doesNotMatch(html, /AVE_AUTH_REQUIRED/);
});

test('页面不再公开展示严格筛选规则', () => {
  assert.doesNotMatch(html, /严格筛选标准/);
  assert.doesNotMatch(html, /Strict screening rules/);
  assert.doesNotMatch(html, /data-i18n="criterion[1-8]"/);
  assert.doesNotMatch(html, /\bcriteriaTitle\s*:/);
  assert.doesNotMatch(html, /class="criteria"/);
});

// AVE is retired as the market source, so there is no provider key form left on
// the page at all - nothing to type, nothing to store, nothing to echo back.
test('生产页面没有行情源配置流程，也不请求钱包私钥或交易权限', () => {
  assert.doesNotMatch(html, /id="(?:gmgnKeyInput|gmgnKeyButton|gmgnKeyStatus|gmgnOnboardingButton|gmgnPublicKey|ave-api-key|aveSettings)"/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/(?:gmgn|ave)-|connectGmgnApi|prepareGmgnOnboarding|changeAve|refreshAve|renderAveConnection/);
  assert.doesNotMatch(html, /gmgn-private-key|privateKey\s*=|eth_requestAccounts|signTransaction|sendTransaction/);
  assert.doesNotMatch(html, /ave\.ai|AVE_AUTH_REQUIRED|AVE_INVITE_URL/);
  assert.doesNotMatch(html, /仅测试行情，约 5 CU。单 Key，无需钱包。/);
});

test('看板包含新鲜度、运行进度和动态降级支持', () => {
  assert.match(html, /最近扫描尝试/);
  assert.match(html, /最近成功扫描/);
  assert.match(html, /下轮扫描/);
  assert.match(html, /数据新鲜度/);
  assert.match(html, /scanInProgress/);
  assert.match(html, /WAIT_RECHECK/);
  assert.match(html, /HARD_REJECT/);
  assert.match(html, /筛选后表现验证/);
  assert.match(html, /30分钟结果/);
  assert.match(html, /2小时结果/);
  assert.match(html, /24小时结果/);
  assert.match(html, /未满50个只做观察，不用于调参/);
  assert.match(html, /prefers-reduced-motion/);
});

test('候选表明确展示GoPlus与DexScreener交叉验证', () => {
  assert.match(html, /GoPlus一票否决/);
  assert.match(html, /GoPlus未见致命项/);
  assert.match(html, /Dex复核/);
  assert.match(html, /多源数据冲突/);
});
