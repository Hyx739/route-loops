/**
 * amap.js — 高德 Web 服务 API 封装（JSONP 调用，纯前端无需后端）
 *
 * 对外接口：
 *   AmapRouter.planLeg(mode, a, b) -> Promise<{distance, duration, points}>
 *     mode: 'run'（步行/跑步，v3 walking）| 'ride'（骑行，v5 bicycling）
 *     a, b: {lat, lng}，坐标为 GCJ-02（高德坐标系），与地图瓦片一致，无需转换
 *   AmapRouter.setTransport(fn)   注入自定义请求实现（Node 测试用 fetch 替代 JSONP）
 *   AmapRouter.parsePolyline(str) 解析 "lng,lat;lng,lat" 字符串
 *
 * 设计要点（均为实测结论）：
 *   1. 环线拆成多段独立 A→B 请求拼接——因为：
 *      · v3 骑行接口已停服（SERVICE_NOT_AVAILABLE），骑行必须用 v5
 *      · v5 的途经点参数对个人开发者返回 21002 无权限
 *      · v3 步行会静默忽略途经点（实测带/不带途经点距离完全相同）
 *      · origin==destination 的请求返回 1 米退化路线
 *   2. 骑行 v5 必须带 show_fields=polyline,cost 才返回路线坐标
 *   3. 个人 Key 有约 3 次/秒的 QPS 限制（CUQPS_HAS_EXCEEDED_THE_LIMIT），
 *      因此所有请求走统一队列：串行 + 最小间隔 350ms，超限自动退避重试
 */
(function (global) {
  'use strict';

  var CALLBACK_TIMEOUT_MS = 15000;
  var MIN_INTERVAL_MS = 350;    // 两次请求的最小起始间隔（start-to-start）。实测无间隔会被
                                // QPS 限制拦截（10021），300ms 稳定；350ms 留有余量且更快
  var QPS_MAX_RETRY = 3;        // 10021（QPS 超限）自动重试次数

  var MODE_URLS = {
    run: 'https://restapi.amap.com/v3/direction/walking',
    ride: 'https://restapi.amap.com/v5/direction/bicycling'
  };

  // 高德错误码 → 中文提示
  var ERROR_MESSAGES = {
    '10001': 'Key 无效：请检查 config.js 中的 AMAP_KEY 是否为「Web服务」类型',
    '10002': '高德服务暂不可用（v3 骑行接口已停服）',
    '10003': '今日访问量已超配额，请明天再试或更换 Key',
    '10004': '访问受限：Key 可能被停用或配额已用尽',
    '10009': 'Key 平台类型不匹配：需要「Web服务」类型的 Key（不是「Web端(JS API)」）',
    '10012': '高德服务内部错误，请稍后重试',
    '10021': '请求过于频繁，请稍后再试',
    '20000': '高德服务错误',
    '20001': '缺少必填参数',
    '20003': '参数格式错误',
    '20800': '规划点不在中国境内，暂不支持',
    '21002': '当前 Key 无该接口权限',
    '30001': '该范围内未找到可规划的道路路线'
  };

  var seq = 0;
  var transport = null;   // 可注入的请求实现（默认 JSONP）

  /* ---------------- 请求队列：串行 + 最小间隔，规避 QPS 限制 ---------------- */

  var queue = [];
  var active = false;
  var lastStartAt = 0;

  function enqueue(task) {
    return new Promise(function (resolve, reject) {
      queue.push({ task: task, resolve: resolve, reject: reject });
      pump();
    });
  }

  function pump() {
    if (active || !queue.length) return;
    var item = queue.shift();
    active = true;
    var wait = Math.max(0, lastStartAt + MIN_INTERVAL_MS - Date.now());
    setTimeout(function () {
      lastStartAt = Date.now();
      item.task().then(function (r) {
        active = false;
        item.resolve(r);
        pump();
      }, function (e) {
        active = false;
        item.reject(e);
        pump();
      });
    }, wait);
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ---------------- 传输层：JSONP（浏览器）/ 可注入（Node 测试） ---------------- */

  /** JSONP 请求（无 CORS 限制） */
  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      var cbName = '__amapJsonp' + (++seq) + '_' + Date.now();
      var script = document.createElement('script');
      var timer = null;
      var settled = false;

      function cleanup() {
        if (timer) clearTimeout(timer);
        try { delete global[cbName]; } catch (e) { global[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(arg);
      }

      global[cbName] = function (data) { finish(resolve, data); };
      script.onerror = function () {
        finish(reject, new Error('网络请求失败：无法连接高德服务器'));
      };
      timer = setTimeout(function () {
        finish(reject, new Error('请求超时：高德服务器响应过慢，请重试'));
      }, CALLBACK_TIMEOUT_MS);

      script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  /** 注入自定义请求实现（参数为完整 URL，返回 Promise<解析后的 JSON>） */
  function setTransport(fn) { transport = fn; }

  function request(url) {
    return transport ? transport(url) : jsonp(url);
  }

  /* ---------------- URL 构造与响应解析 ---------------- */

  function formatPoint(p) {
    return p.lng.toFixed(6) + ',' + p.lat.toFixed(6);
  }

  function buildUrl(mode, a, b) {
    var url = MODE_URLS[mode] + '?origin=' + formatPoint(a) + '&destination=' + formatPoint(b);
    // v5 接口默认不返回路线坐标，必须显式请求（v3 步行默认返回，无需该参数）
    if (mode === 'ride') url += '&show_fields=polyline,cost';
    return url + '&key=' + global.AMAP_KEY;
  }

  /** "lng,lat;lng,lat;..." → [{lat, lng}, ...] */
  function parsePolyline(str) {
    var out = [];
    if (!str) return out;
    var parts = String(str).split(';');
    for (var i = 0; i < parts.length; i++) {
      var xy = parts[i].split(',');
      if (xy.length < 2) continue;
      var lng = parseFloat(xy[0]);
      var lat = parseFloat(xy[1]);
      if (isFinite(lng) && isFinite(lat)) out.push({ lat: lat, lng: lng });
    }
    return out;
  }

  function parseResponse(data) {
    if (!data || data.status !== '1') {
      var code = data && data.infocode;
      var err = new Error(ERROR_MESSAGES[code] ||
        (data && data.info ? '高德接口错误：' + data.info : '高德接口返回异常'));
      err.infocode = code;
      throw err;
    }
    var path = data.route && data.route.paths && data.route.paths[0];
    if (!path) throw new Error('该范围内未找到可规划的道路路线');

    var points = [];
    var steps = path.steps || [];
    for (var i = 0; i < steps.length; i++) {
      var seg = parsePolyline(steps[i].polyline);
      for (var j = 0; j < seg.length; j++) {
        var last = points[points.length - 1];
        if (last && last.lat === seg[j].lat && last.lng === seg[j].lng) continue;
        points.push(seg[j]);
      }
    }
    if (points.length < 2) throw new Error('该范围内未找到可规划的道路路线');

    // v3 walking: paths[0].duration；v5 walking: paths[0].cost.duration；v5 bicycling: paths[0].duration
    var rawDuration = path.duration != null ? path.duration : (path.cost && path.cost.duration);
    var duration = Number(rawDuration);
    if (!isFinite(duration) || duration < 0) duration = 0;

    return {
      distance: Number(path.distance) || 0,
      duration: duration,
      points: points
    };
  }

  /* ---------------- 对外：单段路径规划 ---------------- */

  /**
   * 单段路径规划 a → b（自动排队限速、QPS 超限自动重试）
   * @returns Promise<{distance: 米, duration: 秒, points: [{lat,lng}]}>
   */
  function planLeg(mode, a, b, attempt) {
    var tries = attempt || 0;

    if (!global.AMAP_KEY) {
      return Promise.reject(new Error('未配置高德 Key：请在 config.js 中填写 AMAP_KEY'));
    }
    if (!MODE_URLS[mode]) {
      return Promise.reject(new Error('未知的运动类型：' + mode));
    }

    return enqueue(function () { return request(buildUrl(mode, a, b)); })
      .then(parseResponse)
      .catch(function (err) {
        // QPS 超限：退避后自动重试
        if (err && err.infocode === '10021' && tries < QPS_MAX_RETRY) {
          return delay(600 * Math.pow(2, tries)).then(function () {
            return planLeg(mode, a, b, tries + 1);
          });
        }
        throw err;
      });
  }

  var api = {
    planLeg: planLeg,
    setTransport: setTransport,
    parsePolyline: parsePolyline,
    ERROR_MESSAGES: ERROR_MESSAGES,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.AmapRouter = api;
})(typeof window !== 'undefined' ? window : globalThis);
