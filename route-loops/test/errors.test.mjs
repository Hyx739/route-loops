/**
 * errors.test.mjs — 异常路径测试（验证错误提示对用户友好、可指导操作）
 *
 * 运行：node test/errors.test.mjs
 *
 * 覆盖：
 *   1. 未配置 Key            → 提示去 config.js 填写
 *   2. Key 无效（假值）      → 提示 Key 无效且指明需「Web服务」类型
 *   3. 未知运动类型          → 提示未知类型
 *   4. 未选起点 / 距离非法   → 生成流程给出可操作提示
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const AmapRouter = require('../js/amap.js');
const LoopGen = require('../js/loopgen.js');
AmapRouter.setTransport(async (url) => (await fetch(url)).json());

const A = { lat: 39.90923, lng: 116.397428 };
const B = { lat: 39.925, lng: 116.415 };

async function expectMessage(promise, pattern, label) {
  try {
    await promise;
    check(false, label, '本应报错却成功了');
  } catch (err) {
    check(pattern.test(err.message), label, `实际提示：「${err.message}」`);
  }
}

async function main() {
  console.log('\n=== 异常路径 ===');

  // 1. 未配置 Key
  globalThis.AMAP_KEY = '';
  await expectMessage(
    AmapRouter.planLeg('run', A, B),
    /config\.js/,
    '未配置 Key 时提示去 config.js 填写'
  );

  // 2. Key 无效（真实请求，高德返回 10001）
  globalThis.AMAP_KEY = '0000000000000000000000000000abcd';
  await expectMessage(
    AmapRouter.planLeg('run', A, B),
    /Key 无效.*Web服务/,
    'Key 无效时提示类型要求（Web服务）'
  );

  // 3. 未知运动类型
  globalThis.AMAP_KEY = '';
  await expectMessage(
    AmapRouter.planLeg('swim', A, B),
    /未知的运动类型/,
    '未知运动类型提示明确'
  );

  // 4. 生成流程：未选起点 / 距离非法
  await expectMessage(
    LoopGen.generateLoops({ targetKm: 10, mode: 'run', routeFn: AmapRouter.planLeg }),
    /出发点/,
    '未选起点时提示先选出发点'
  );
  await expectMessage(
    LoopGen.generateLoops({ start: A, targetKm: 0, mode: 'run', routeFn: AmapRouter.planLeg }),
    /目标距离/,
    '距离非法时提示输入有效距离'
  );

  console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('测试异常：', err);
  process.exitCode = 1;
});
