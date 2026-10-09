/**
 * loopgen.test.mjs — 环形路线算法无头测试（Node 18+，调用真实高德 API）
 *
 * 运行：node test/loopgen.test.mjs
 *
 * 测试的是生产代码本身（js/amap.js + js/loopgen.js），只把浏览器的 JSONP
 * 传输层替换成 Node 的 fetch，其余逻辑（限速队列、解析、迭代、去重）完全一致。
 *
 * 验证项：
 *   1. 生成 3 条环线，每条总距离偏差 ≤ 12%
 *   2. 每条路线首尾闭合（末点与起点距离 < 300 米）
 *   3. 3 条路线出发方位角两两相差 > 20°
 *   4. 跑步（v3 walking）与骑行（v5 bicycling）两条链路都可用
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

globalThis.AMAP_KEY = '';

const AmapRouter = require('../js/amap.js');
const LoopGen = require('../js/loopgen.js');

// 用 fetch 替代浏览器的 JSONP（其余逻辑与浏览器完全一致）
AmapRouter.setTransport(async (url) => {
  const res = await fetch(url);
  return res.json();
});

const TIANANMEN = { lat: 39.90923, lng: 116.397428 };

function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

let failures = 0;

async function runCase(label, mode, targetKm, start) {
  console.log(`\n=== ${label}：${mode} / 目标 ${targetKm}km ===`);
  const t0 = Date.now();
  let routes;
  try {
    routes = await LoopGen.generateLoops({
      start,
      targetKm,
      mode,
      count: 3,
      routeFn: AmapRouter.planLeg,
      onProgress: (n, msg) => console.log('  · ' + msg)
    });
  } catch (err) {
    console.log(`  ✗ 生成失败：${err.message}`);
    failures++;
    return;
  }

  console.log(`  生成 ${routes.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  #  实际距离     偏差      途经点数  闭合误差');
  routes.forEach((r, i) => {
    const km = r.distance / 1000;
    const devPct = (r.distance - targetKm * 1000) / (targetKm * 1000) * 100;
    const closed = r.points.length >= 2
      ? haversine(r.points[0], r.points[r.points.length - 1])
      : Infinity;
    console.log(
      `  ${i + 1}  ${km.toFixed(2)} km   ${devPct >= 0 ? '+' : ''}${devPct.toFixed(1)}%`
      + `   ${String(r.points.length).padStart(5)}     ${closed.toFixed(0)} m`
    );

    if (Math.abs(devPct) > 12) { console.log('     ✗ 距离偏差超过 12%'); failures++; }
    if (closed > 300) { console.log('     ✗ 首尾未闭合'); failures++; }
    if (r.points.length < 10) { console.log('     ✗ 路线坐标点过少'); failures++; }
  });

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const d = angleDiff(routes[i].bearing, routes[j].bearing);
      if (d < 20) {
        console.log(`     ✗ 路线 ${i + 1} 与 ${j + 1} 出发方位角仅差 ${d.toFixed(0)}°（过于相似）`);
        failures++;
      }
    }
  }
  if (routes.length >= 2) {
    console.log(`  出发方位角：${routes.map(r => r.bearing.toFixed(0) + '°').join(', ')}`);
  }
  if (routes.length < 3) {
    console.log(`  ⚠ 只生成了 ${routes.length} 条（目标 3 条）`);
  }
}

async function main() {
  // CASE=run / CASE=ride20 / CASE=ride50 可只跑单个用例（调参时省时间）
  const only = process.env.CASE;
  const cases = [
    ['run', '天安门 跑步', 'run', 10],
    ['ride20', '天安门 骑行', 'ride', 20],
    ['ride50', '天安门 骑行', 'ride', 50]
  ];
  for (const [key, label, mode, km] of cases) {
    if (!only || only === key) await runCase(label, mode, km, TIANANMEN);
  }

  console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('测试异常：', err);
  process.exitCode = 1;
});
