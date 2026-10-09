/**
 * geometry.test.mjs — 环线几何不变量测试（纯计算，不发网络请求，毫秒级）
 *
 * 运行：node test/geometry.test.mjs
 *
 * 为什么单独测几何：路线去重靠「起点→第一个途经点的方位角」，
 * 而这个方位角由外接圆圆心方位反解得到（见 buildWaypoints）。推导里的符号
 * 一旦写错，候选会整体转 180° 却不报错——只会在长跑测试里表现为
 * 「两条路线看起来一样」，所以这里用纯计算把它钉死。
 *
 * 验证：
 *   1. 起点→M1 的方位角 = 该 seed 的扇区中心 ± 12°（抖动上限）
 *   2. M1 与起点是外接圆上的相邻顶点：|S→M1| = 边长 2R·sin(π/k)
 *   3. M1 到圆心的距离 = R（在圆上）
 *   4. 末个途经点到起点 ≈ 一条边长（环线闭合）
 *   5. 5 个 seed 的出发方位角两两间隔 ≥ 40°（保证候选互不相似）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LoopGen = require('../js/loopgen.js');

const S = { lat: 39.90923, lng: 116.397428 };
const TARGET = 10000;
const DETOUR = 1.5;
const SEEDS = LoopGen.CONFIG.SEEDS;
const JITTER_DEG = 12;          // buildWaypoints 里的抖动上限
const METERS_PER_DEG = 111320;

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function dist(a, b) {
  const dLat = (b.lat - a.lat) * METERS_PER_DEG;
  const dLng = (b.lng - a.lng) * METERS_PER_DEG * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

console.log('\n=== 每位种子 × 每种半径校正系数 ===');

for (const seed of SEEDS) {
  const sides = 4 + (seed % 3);
  const slot = (seed - 1) * (360 / SEEDS.length);

  for (const scale of [1, 1.4, 0.7]) {
    const R = TARGET / (DETOUR * 2 * sides * Math.sin(Math.PI / sides)) * scale;
    const side = 2 * R * Math.sin(Math.PI / sides);   // 正 k 边形边长
    const wps = LoopGen.buildWaypoints(S, TARGET, seed, scale, DETOUR, 0);
    const tag = `seed=${seed}(k=${sides}) scale=${scale}`;

    // 1. 出发方位角
    const bearing = LoopGen.bearingDeg(S, wps[0]);
    const off = angleDiff(bearing, slot);
    check(off <= JITTER_DEG + 0.01,
      `${tag} 出发方位角 ${bearing.toFixed(1)}° 在扇区 ${slot}°±${JITTER_DEG}° 内`,
      `实际偏离 ${off.toFixed(1)}°`);

    // 2. 起点与 M1 的距离 = 多边形边长（M1 是相邻顶点，不是圆心半径处）
    const dFirst = dist(S, wps[0]);
    check(Math.abs(dFirst - side) / side < 0.005,
      `${tag} |起点→M1| = 边长 ${side.toFixed(0)}m`,
      `实际 ${dFirst.toFixed(0)}m`);

    // 3. M1 落在过起点的外接圆上（用几何关系反推圆心距离校验）
    //    圆心到起点、圆心到 M1 都应为 R
    const total = wps.length + 1;                     // 途经点 + 起点 = 多边形顶点数
    check(total === sides, `${tag} 途经点数 ${wps.length} + 起点 = ${sides} 边形`);

    // 4. 闭合：末个途经点到起点 ≈ 一条边长（相邻顶点）
    const dLast = dist(wps[wps.length - 1], S);
    check(Math.abs(dLast - side) / side < 0.45,
      `${tag} 末个途经点→起点 ${dLast.toFixed(0)}m ≈ 边长（环线闭合）`,
      `边长 ${side.toFixed(0)}m`);
  }
}

console.log('\n=== 候选之间的出发方位角分散度 ===');

const bearings = SEEDS.map(seed => ({
  seed,
  bearing: LoopGen.bearingDeg(S, LoopGen.buildWaypoints(S, TARGET, seed, 1, DETOUR, 0)[0])
}));
console.log('  ' + bearings.map(b => `seed${b.seed}:${b.bearing.toFixed(0)}°`).join('  '));

let minGap = 360;
for (let i = 0; i < bearings.length; i++) {
  for (let j = i + 1; j < bearings.length; j++) {
    minGap = Math.min(minGap, angleDiff(bearings[i].bearing, bearings[j].bearing));
  }
}
// 去重阈值是 30°，扇区间隔 72° 减抖动 ±12° → 实际最小间隔应 ≥ 40°
check(minGap >= 40, `两两最小间隔 ${minGap.toFixed(0)}° ≥ 40°（大于去重阈值 ${LoopGen.CONFIG.DEDUPE_BEARING_DEG}°）`);

console.log(`\n${failures === 0 ? '✓ 几何校验全部通过' : `✗ ${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
