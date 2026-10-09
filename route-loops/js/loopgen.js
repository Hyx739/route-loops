/**
 * loopgen.js — 环形路线生成算法（纯逻辑，路由函数由外部注入，可在 Node 中无头测试）
 *
 * 原理：
 *   1. 把起点 S 作为正 k 边形（k=4~6）的一个顶点，其余顶点落在过 S 的外接圆上，
 *      路线 S→M1→…→M(k-1)→S 沿多边形的边走一圈，即得闭合环线
 *      （正 k 边形外接圆半径 R 时周长 = 2kR·sin(π/k)）
 *   2. 用道路绕行系数（实测 ≈1.3）估算外接圆半径初值 R
 *   3. 拆成 k 段独立 A→B 规划请求（S→M1, M1→M2, …, M(k-1)→S）拼接成环线
 *      （高德不支持真实途经点/环形接口，多段拼接是实测唯一可行方案）
 *   4. 按实际总距离与目标距离的偏差迭代校正半径，偏差 ≤ 10% 即接受；
 *      并用前序候选的实测绕行比修正后续候选的半径初值（自学习，减少迭代次数）
 *   5. 不同 seed 产生形态差异（边数、出发方位、绕行方向、椭圆形态、抖动），
 *      按出发方位角去重（相差 < 30° 视为相似），保留偏差最小的 count 条
 *
 * 注意：个人 Key 有约 3 次/秒的 QPS 限制（见 amap.js 的请求队列），
 *       因此边数与迭代次数都刻意压小，单次生成约 15~25 次请求。
 */
(function (global) {
  'use strict';

  var CONFIG = {
    // 道路绕行系数初值（实测标定）
    //   骑行：1.42~1.47，几乎不随半径变化（线性好）
    //   跑步：1.47~2.08，半径越小绕行越大（受路口/过街设施/禁行区影响，强非线性）
    MODE_DETOUR: { run: 1.5, ride: 1.44 },
    // 半径校正指数：道路距离 ≈ 半径^p。骑行接近线性（指数≈1）；
    // 跑步强非线性（实测 p≈0.2~0.6），需要更猛地缩小半径才能把距离压下来
    MODE_EXPONENT: { run: 1.7, ride: 1.05 },
    MAX_DEVIATION: 0.10,     // 允许的距离偏差（10%）
    NEAR_MISS_DEVIATION: 0.18,// 「差一点」阈值：偏差在此以内的候选多给一次迭代机会
    FALLBACK_DEVIATION: 0.25,// 无候选达标时的兜底偏差上限
    MAX_ATTEMPTS: 2,         // 每个候选的半径迭代上限（通常 1~2 次收敛）
    SEEDS: [1, 2, 3, 4, 5],
    DEDUPE_BEARING_DEG: 30,  // 出发方位角相差小于该值视为相似路线
    CONCURRENCY: 3           // 并发上限（实际由 amap.js 的请求队列统一限速）
  };

  var MIN_SCALE = 0.4;
  var MAX_SCALE = 2.5;

  /** 确定性伪随机（同 seed 结果可复现） */
  function pseudoRandom(i) {
    var x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function toRad(d) { return d * Math.PI / 180; }

  /** 以 start 为原点，向东 dx 米、向北 dy 米的经纬度 */
  function metersToLatLng(start, dxEast, dyNorth) {
    return {
      lat: start.lat + dyNorth / 111320,
      lng: start.lng + dxEast / (111320 * Math.cos(toRad(start.lat)))
    };
  }

  /** start → p 的初始方位角（0=正北，顺时针，单位度） */
  function bearingDeg(start, p) {
    var dLng = toRad(p.lng - start.lng);
    var lat1 = toRad(start.lat);
    var lat2 = toRad(p.lat);
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /** 两点近似距离（米，等距圆柱投影，短距离足够精确） */
  function approxDist(a, b) {
    var dLat = (b.lat - a.lat) * 111320;
    var dLng = (b.lng - a.lng) * 111320 * Math.cos(toRad((a.lat + b.lat) / 2));
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  /** 折线总长度（米） */
  function polylineLength(pts) {
    var total = 0;
    for (var i = 0; i < pts.length - 1; i++) total += approxDist(pts[i], pts[i + 1]);
    return total;
  }

  /**
   * 生成一个候选环线的途经点序列
   *
   * 几何设计：把起点 S 作为正 k 边形的一个顶点，其余顶点分布在过 S 的外接圆上，
   * 路线 S→M1→…→M(k-1)→S 正好沿多边形的边走一圈，天然构成平滑闭合环线。
   * （正 k 边形外接圆半径 R 时，周长 = 2kR·sin(π/k)）
   * k 取 4/5/6，避免出现「两点相隔 180° 与起点共线」的退化往返路线。
   *
   * @param start {lat,lng}
   * @param targetMeters 目标距离（米）
   * @param seed 决定边数(4~6)、出发方位、绕行方向、椭圆形态与抖动
   * @param radiusScale 半径校正系数（迭代用，默认 1）
   * @param detour 绕行系数（默认用 CONFIG.DETOUR，生成过程中会自学习修正）
   * @param nonce 每次生成的随机偏移，让同距离每次生成出的路线形态不同
   */
  function buildWaypoints(start, targetMeters, seed, radiusScale, detour, nonce) {
    var sides = 4 + (seed % 3);                        // 4 / 5 / 6 边形
    var d = detour || CONFIG.DETOUR;
    var nz = nonce || 0;
    var R = targetMeters / (d * 2 * sides * Math.sin(Math.PI / sides)) * (radiusScale || 1);

    // 出发方位：候选按种子均分圆周扇区，再叠加 ±12° 抖动，保证各候选出发方向互不聚集
    var slot = 360 / CONFIG.SEEDS.length;
    var theta = (seed - 1) * slot
      + (pseudoRandom(seed * 53 + nz * 11) - 0.5) * 24;
    var dir = (seed % 2 === 0) ? 1 : -1;               // 顺时针 / 逆时针
    var step = dir * (360 / sides);

    // 外接圆圆心方位 beta：由「从起点到第一个途经点 M1 的方位角恰为 theta」反解。
    // S 与 M1 是正 k 边形的相邻顶点（相隔一个圆心角 360/k），从 S 看圆心，
    // 方向 = 弦方向转 90° 再加半个圆心角（180/k）；dir=+1 即逆时针布局时还要翻 180°。
    // 这样「起点→M1 的方位角」恒等于 theta，按方位去重才与用户看到的出发方向一致。
    var beta = theta - 90 - dir * (180 / sides) - (dir > 0 ? 180 : 0);
    var center = metersToLatLng(start, R * Math.sin(toRad(beta)), R * Math.cos(toRad(beta)));

    var stretch = [0.88, 1.0, 1.12, 0.95][seed % 4];   // 椭圆拉伸（形态差异）
    var s2 = stretch * stretch;
    var rotA = toRad(seed * 30 + nz * 60);
    var base = beta + 180;                             // 圆心到 S 的方位角（S 在顶点 0）

    // M1 不做抖动与拉伸，保证「起点→M1 的方位角」精确等于 theta
    var pts = [metersToLatLng(
      center,
      R * Math.sin(toRad(base + step)),
      R * Math.cos(toRad(base + step))
    )];

    for (var k = 2; k < sides; k++) {
      var angDeg = base + step * k
        + (pseudoRandom(seed * 97 + k + nz * 13) - 0.5) * 12;
      var ang = toRad(angDeg);
      // 椭圆极径（长轴 R·stretch、短轴 R，整体旋转 rotA）
      var t = ang - rotA;
      var r = R * Math.sqrt(s2 * Math.cos(t) * Math.cos(t) + Math.sin(t) * Math.sin(t));
      r *= 0.94 + 0.12 * pseudoRandom(seed * 131 + k + nz * 29);
      // 相对圆心的偏移：向东 r·sin(方位角)、向北 r·cos(方位角)
      pts.push(metersToLatLng(center, r * Math.sin(ang), r * Math.cos(ang)));
    }
    return pts;
  }

  /** 并发上限控制 */
  function mapLimit(items, limit, fn) {
    return new Promise(function (resolve, reject) {
      var results = new Array(items.length);
      var nextIdx = 0;
      var active = 0;
      var failed = false;

      function pump() {
        if (failed) return;
        if (nextIdx >= items.length && active === 0) return resolve(results);
        while (active < limit && nextIdx < items.length) {
          (function (idx) {
            active++;
            fn(items[idx], idx).then(function (r) {
              results[idx] = r;
              active--;
              pump();
            }, function (err) {
              failed = true;
              reject(err);
            });
          })(nextIdx++);
        }
      }
      pump();
    });
  }

  function withRetry(fn, retries) {
    return fn().catch(function (err) {
      if (retries <= 0) throw err;
      return new Promise(function (r) { setTimeout(r, 300); }).then(function () {
        return withRetry(fn, retries - 1);
      });
    });
  }

  /**
   * 生成一个候选环线（含半径迭代校正）
   * @param ctx {detour, nonce, exponent}
   *   detour   半径估算使用的绕行系数（由前序候选实测自学习）
   *   nonce    本次生成的随机偏移
   *   exponent 半径校正指数（补偿不同运动方式的非线性）
   * @returns Promise<{distance, duration, points, seed, deviation, bearing, detourRatio}>
   *   detourRatio 本候选实测绕行比，供后续候选自学习
   */
  function routeCandidate(start, targetMeters, seed, mode, routeFn, ctx) {
    var scale = 1;
    var c = ctx || {};
    var exponent = c.exponent || 1;
    var lastScale = 0;   // 上一次迭代用的半径系数
    var lastTotal = 0;   // 上一次迭代实测的距离（与 lastScale 构成一个实测点）

    function attempt(iter) {
      var wps = buildWaypoints(start, targetMeters, seed, scale, c.detour, c.nonce);
      var stops = [start].concat(wps, [start]);
      var legs = [];
      for (var i = 0; i < stops.length - 1; i++) legs.push([stops[i], stops[i + 1]]);

      return mapLimit(legs, CONFIG.CONCURRENCY, function (leg) {
        return withRetry(function () { return routeFn(mode, leg[0], leg[1]); }, 1);
      }).then(function (results) {
        var total = 0;
        var duration = 0;
        var points = [];
        for (var i = 0; i < results.length; i++) {
          total += results[i].distance || 0;
          duration += results[i].duration || 0;
          var seg = results[i].points || [];
          for (var j = 0; j < seg.length; j++) {
            var last = points[points.length - 1];
            // 相邻两段在途经点处重复的点只保留一个
            if (last && last.lat === seg[j].lat && last.lng === seg[j].lng) continue;
            points.push(seg[j]);
          }
        }

        // 实测绕行比：实际道路距离 / 直线折线距离（供后续候选修正半径初值）
        var straight = polylineLength(stops);
        var detourRatio = straight > 0 && total > 0 ? total / straight : 0;

        var deviation = targetMeters > 0 ? Math.abs(total - targetMeters) / targetMeters : 1;
        // 「差一点」（偏差 10%~18%）的候选多给一次迭代机会——已经发出去的请求不白费；
        // 偏差过大的候选直接放弃，省下请求留给后续 seed
        var iterLimit = CONFIG.MAX_ATTEMPTS
          + (deviation <= CONFIG.NEAR_MISS_DEVIATION ? 1 : 0);
        if (deviation <= CONFIG.MAX_DEVIATION || iter >= iterLimit || total <= 0) {
          return {
            distance: total,
            duration: duration,
            points: points,
            seed: seed,
            deviation: deviation,
            bearing: bearingDeg(start, wps[0]),
            detourRatio: detourRatio
          };
        }
        // 有两次实测点后，用 log-log 割线估计本候选的局部指数 p，
        // 比固定指数更贴合本地路网（跑步绕行系数随半径变化快，固定指数误差大）
        if (lastScale > 0 && lastTotal > 0 && scale !== lastScale) {
          var p = Math.log(total / lastTotal) / Math.log(scale / lastScale);
          if (isFinite(p) && p > 0.2 && p < 3) {
            exponent = Math.max(0.5, Math.min(2.5, 1 / p));
          }
        }
        // 校正半径后重试：距离 ∝ 半径^p，故按 (目标/实际)^(1/p) 缩放
        var factor = Math.pow(targetMeters / total, exponent);
        lastScale = scale;
        lastTotal = total;
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
        return attempt(iter + 1);
      });
    }
    return attempt(1);
  }

  /** 按出发方位角筛选出互不相似的候选（不补足，纯去重） */
  function distinctByBearing(candidates) {
    var sorted = candidates.slice().sort(function (a, b) {
      return a.deviation - b.deviation;
    });
    var kept = [];
    sorted.forEach(function (c) {
      var similar = kept.some(function (k) {
        return angleDiff(c.bearing, k.bearing) < CONFIG.DEDUPE_BEARING_DEG;
      });
      if (!similar) kept.push(c);
    });
    return kept;
  }

  /** 去重后取前 count 条；方位角不够分散导致数量不足时，用剩余候选补足 */
  function dedupe(candidates, count) {
    var kept = distinctByBearing(candidates);
    if (kept.length < count) {
      candidates.slice().sort(function (a, b) {
        return a.deviation - b.deviation;
      }).forEach(function (c) {
        if (kept.length >= count) return;
        if (kept.indexOf(c) === -1) kept.push(c);
      });
    }
    return kept.slice(0, count);
  }

  /**
   * 生成环形路线
   * @param opts {start, targetKm, mode, count=3, routeFn, onProgress}
   *   routeFn(mode, a, b) -> Promise<{distance, duration, points}>
   *   onProgress(tried, message)
   * @returns Promise<候选数组，按偏差升序，最多 count 条>
   */
  function generateLoops(opts) {
    var start = opts.start;
    var targetMeters = opts.targetKm * 1000;
    var mode = opts.mode;
    var count = opts.count || 3;
    var routeFn = opts.routeFn;
    var onProgress = opts.onProgress || function () {};

    if (!start) return Promise.reject(new Error('请先在地图上选择出发点'));
    if (!(targetMeters > 0)) return Promise.reject(new Error('请输入有效的目标距离'));
    if (typeof routeFn !== 'function') return Promise.reject(new Error('缺少路由函数'));

    var seeds = CONFIG.SEEDS.slice();
    var accepted = [];   // 偏差达标的候选
    var all = [];        // 全部完成的候选（兜底用）
    var tried = 0;
    var lastError = null;
    var nonce = opts.nonce != null ? opts.nonce : Math.random() * 10;
    var exponent = CONFIG.MODE_EXPONENT[mode] || 1;
    // 绕行系数自学习：用前一条候选的实测绕行比修正后续候选的半径初值，
    // 使大多数候选更快收敛（更准、更省请求）
    var detour = CONFIG.MODE_DETOUR[mode] || 1.4;

    function next() {
      // 停止条件：凑齐 count 条互不相似的达标路线即停（受 QPS 限制，省请求优先）
      if (!seeds.length) return Promise.resolve();
      if (distinctByBearing(accepted).length >= count && accepted.length >= count) {
        return Promise.resolve();
      }
      var seed = seeds.shift();
      tried++;
      onProgress(tried, '正在规划第 ' + tried + ' 条候选路线…');
      return routeCandidate(start, targetMeters, seed, mode, routeFn, {
        detour: detour,
        nonce: nonce,
        exponent: exponent
      }).then(function (c) {
        all.push(c);
        if (c.detourRatio > 0.8 && c.detourRatio < 2.5) {
          detour = detour * 0.65 + c.detourRatio * 0.35;
        }
        if (c.deviation <= CONFIG.MAX_DEVIATION) accepted.push(c);
      }).catch(function (err) {
        lastError = err;   // 单条候选失败：跳过并记录原因
      }).then(next);
    }

    return next().then(function () {
      // 达标候选优先；一条都不达标时退回偏差较小的候选兜底（至少给出可用路线）
      var pool = accepted.length ? accepted : all.filter(function (c) {
        return c.deviation <= CONFIG.FALLBACK_DEVIATION;
      });
      var result = dedupe(pool, count);
      if (!result.length) {
        // 把底层真实原因（Key 无效 / 配额超限 / 网络错误）透传给用户
        throw new Error(lastError
          ? lastError.message
          : '未能生成符合要求的路线：可尝试调整距离，或换一个出发点');
      }
      return result;
    });
  }

  var api = {
    CONFIG: CONFIG,
    generateLoops: generateLoops,
    buildWaypoints: buildWaypoints,
    metersToLatLng: metersToLatLng,
    bearingDeg: bearingDeg
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.LoopGen = api;
})(typeof window !== 'undefined' ? window : globalThis);
