/**
 * e2e.mjs — 浏览器端到端测试（Chrome 无头模式 + DevTools 协议，零依赖）
 *
 * 运行：node test/e2e.mjs          （需要本地服务器已在 8000 端口运行）
 *
 * 流程：打开页面 → 等待地图与瓦片加载 → 模拟点击地图选出发点 →
 *       输入 10km → 点击「生成路线」→ 等待 3 条路线卡片 → 校验数据 →
 *       测试卡片选中联动 → 截图（桌面 + 移动端）
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PAGE_URL = 'http://localhost:8000/';
const SHOT_DESKTOP = '/tmp/route-loops-desktop.png';
const SHOT_MOBILE = '/tmp/route-loops-mobile.png';

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 启动 Chrome ---------------- */

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/route-loops-e2e-profile',
  '--window-size=1280,900',
  PAGE_URL
], { stdio: 'ignore' });

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.url.includes('localhost:8000'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('无法连接 Chrome DevTools');
}

/* ---------------- CDP 客户端 ---------------- */

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let msgId = 0;
const pending = new Map();
const pageErrors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(d.exception ? d.exception.description : d.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    pageErrors.push(msg.params.entry.text);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('页面脚本异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(expression, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(500);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${label}`);
}

async function screenshot(path) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  console.log(`  · 截图已保存：${path}`);
}

/* ---------------- 测试流程 ---------------- */

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // Chrome profile 目录跨轮次复用，必须禁用缓存，否则测到的是旧版 CSS/JS
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.reload', { ignoreCache: true });
  await sleep(500);

  console.log('\n[1] 页面与地图加载');
  await waitFor('!!document.querySelector(".leaflet-container")', 15000, 'Leaflet 容器');
  check(true, 'Leaflet 地图已初始化');
  await waitFor('document.querySelectorAll(".leaflet-tile-loaded").length > 0', 20000, '高德瓦片加载');
  const tileCount = await evaluate('document.querySelectorAll(".leaflet-tile-loaded").length');
  check(tileCount > 0, `高德瓦片已加载（${tileCount} 张）`);

  console.log('\n[2] 点击地图选择出发点');
  await evaluate(`(function () {
    var el = document.querySelector('#map');
    var r = el.getBoundingClientRect();
    var x = r.left + r.width * 0.62, y = r.top + r.height * 0.42;
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0
      }));
    });
    return true;
  })()`);
  await sleep(300);
  const startSet = await evaluate('document.getElementById("startLabel").classList.contains("is-set")');
  const startText = await evaluate('document.getElementById("startLabel").textContent');
  check(startSet, '出发点已设置：' + startText);

  console.log('\n[3] 输入 10km 并生成路线');
  await evaluate(`(function () {
    var n = document.getElementById('distNumber');
    n.value = 10;
    n.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('generateBtn').click();
    return true;
  })()`);
  await sleep(500);
  const busy = await evaluate('document.getElementById("generateBtn").disabled');
  check(busy, '生成中按钮已禁用（防重复提交）');

  await waitFor('document.querySelectorAll(".card").length >= 1', 120000, '路线卡片出现');
  // 等到按钮恢复可用 = 整批生成结束（择优候选也跑完了）
  await waitFor('!document.getElementById("generateBtn").disabled', 120000, '生成完成');

  console.log('\n[4] 校验生成结果');
  const result = await evaluate(`JSON.stringify({
    cards: [].map.call(document.querySelectorAll('.card'), function (c) {
      return c.textContent.replace(/\\s+/g, ' ').trim();
    }),
    lines: document.querySelectorAll('path.leaflet-interactive').length,
    busy: document.getElementById('generateBtn').disabled,
    // 查计算样式而非 hidden 属性：display:flex 会盖掉 [hidden]，只看属性会漏掉视觉 bug
    statusVisible: getComputedStyle(document.getElementById('status')).display !== 'none'
  })`);
  const data = JSON.parse(result);
  console.log('  卡片内容：');
  data.cards.forEach(c => console.log('    · ' + c));

  check(data.cards.length === 3, `生成了 3 条路线`, `实际 ${data.cards.length} 条`);
  check(data.lines === 3, `地图上有 3 条路线折线`, `实际 ${data.lines} 条`);
  check(!data.busy && !data.statusVisible, '生成完成后按钮恢复、状态提示消失');

  // 距离偏差校验（从卡片文本解析 "偏差 +x.x%"）
  let devOk = true;
  data.cards.forEach((text, i) => {
    const m = text.match(/偏差\s*([+-]?\d+(?:\.\d+)?)%/);
    if (!m) { devOk = false; console.log(`    ✗ 路线 ${i + 1} 未找到偏差信息`); return; }
    const dev = Math.abs(parseFloat(m[1]));
    if (dev > 12) { devOk = false; console.log(`    ✗ 路线 ${i + 1} 偏差 ${dev}% 超过 12%`); }
  });
  check(devOk, '各路线距离偏差均在 12% 以内');

  console.log('\n[5] 卡片与路线联动');
  await evaluate('document.querySelectorAll(".card")[0].click()');
  await sleep(300);
  const sel = await evaluate(`JSON.stringify({
    active: document.querySelectorAll('.card.is-active').length,
    borderColor: document.querySelectorAll('.card')[0].style.borderColor
  })`);
  const selData = JSON.parse(sel);
  check(selData.active === 1 && selData.borderColor, '点击卡片后高亮选中（其余变淡）',
    JSON.stringify(selData));

  // 再点一次取消选中，让截图里三条路线都完整可见
  await evaluate('document.querySelectorAll(".card")[0].click()');
  await sleep(300);
  const deselected = await evaluate('document.querySelectorAll(".card.is-active").length');
  check(deselected === 0, '再次点击取消选中');

  console.log('\n[6] 截图');
  await screenshot(SHOT_DESKTOP);

  console.log('\n[7] 移动端（400px 宽）生成与自适应');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 820, deviceScaleFactor: 2, mobile: true
  });
  await sleep(1200);
  // 窄屏下重新生成：验证自动缩放会把路线完整放进底部抽屉之上的可见区域
  await evaluate('document.getElementById("generateBtn").click()');
  await waitFor('document.querySelectorAll(".card").length >= 1', 120000, '移动端生成路线');
  await waitFor('!document.getElementById("generateBtn").disabled', 120000, '移动端生成完成');
  await sleep(800);

  const layout = JSON.parse(await evaluate(`(function () {
    var bottoms = [].map.call(document.querySelectorAll('path.leaflet-interactive'), function (p) {
      return p.getBoundingClientRect().bottom;
    });
    return JSON.stringify({
      routes: bottoms.length,
      maxBottom: bottoms.length ? Math.max.apply(null, bottoms) : 0,
      panelTop: document.getElementById('panel').getBoundingClientRect().top,
      vh: window.innerHeight
    });
  })()`));
  check(
    layout.routes >= 1 && layout.maxBottom <= layout.panelTop,
    '路线完整落在底部抽屉上方（不被遮挡）',
    `路线最低点 ${Math.round(layout.maxBottom)}px / 抽屉顶边 ${Math.round(layout.panelTop)}px`
  );
  await screenshot(SHOT_MOBILE);
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('\n[8] 页面错误检查');
  const realErrors = pageErrors.filter(e => !/favicon/i.test(e));
  check(realErrors.length === 0, '运行期间无页面报错',
    realErrors.length ? realErrors.slice(0, 3).join(' | ') : '');
} catch (err) {
  failures++;
  console.log(`\n✗ 测试异常：${err.message}`);
} finally {
  try { ws.close(); } catch (e) { /* ignore */ }
  chrome.kill('SIGKILL');
}

console.log(`\n${failures === 0 ? '✓ 端到端测试全部通过' : `✗ ${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
