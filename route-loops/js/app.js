/**
 * app.js — 界面逻辑：地图、选点、参数控制、生成与展示
 *
 * 坐标系说明：
 *   地图瓦片与高德接口均为 GCJ-02，二者一致，无需转换。
 *   唯独浏览器 Geolocation 返回的是 WGS-84，在国内与 GCJ-02 有 100~600 米偏差，
 *   因此「定位」功能必须做 WGS-84 → GCJ-02 转换（见 wgs84ToGcj02）。
 */
(function () {
  'use strict';

  var COLORS = ['#e6194b', '#2e9e4f', '#4363d8'];
  var SPEED_KMH = { run: 10, ride: 18 };        // 用时估算所用速度（跑步 10km/h、骑行 18km/h）
  var MODE_LIMITS = {
    run: { min: 3, max: 42, def: 10 },
    ride: { min: 10, max: 150, def: 50 }
  };
  var DEFAULT_CENTER = [39.90923, 116.397428];
  var STORAGE_KEY = 'route-loops:last-state';

  var state = {
    mode: 'run',
    start: null,
    marker: null,
    routes: [],
    selected: -1,
    targetKm: 0,
    busy: false
  };

  /* ---------------- DOM ---------------- */

  function $(id) { return document.getElementById(id); }

  var modeSwitch = $('modeSwitch');
  var distRange = $('distRange');
  var distNumber = $('distNumber');
  var distMin = $('distMin');
  var distMax = $('distMax');
  var startLabel = $('startLabel');
  var locateBtn = $('locateBtn');
  var clearBtn = $('clearBtn');
  var generateBtn = $('generateBtn');
  var statusEl = $('status');
  var statusText = $('statusText');
  var cardsEl = $('cards');
  var toastEl = $('toast');

  /* ---------------- 坐标系转换：WGS-84 → GCJ-02 ---------------- */

  var GCJ_A = 6378245.0;
  var GCJ_EE = 0.00669342162296594323;

  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    var ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return ret;
  }

  /** WGS-84（GPS/浏览器定位）→ GCJ-02（高德地图），境外坐标原样返回 */
  function wgs84ToGcj02(lat, lng) {
    if (outOfChina(lat, lng)) return { lat: lat, lng: lng };
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * Math.PI;
    var magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  /* ---------------- 地图 ---------------- */

  var map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 12);

  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}', {
    subdomains: ['1', '2', '3', '4'],
    minZoom: 3,
    maxZoom: 18,
    attribution: '&copy; <a href="https://lbs.amap.com/" target="_blank" rel="noopener">高德地图</a>'
  }).addTo(map);

  map.on('click', function (e) {
    setStart(e.latlng.lat, e.latlng.lng);
  });

  /* ---------------- 出发点 ---------------- */

  function setStart(lat, lng) {
    state.start = { lat: lat, lng: lng };
    if (state.marker) {
      state.marker.setLatLng([lat, lng]);
    } else {
      state.marker = L.circleMarker([lat, lng], {
        radius: 7,
        color: '#fff',
        weight: 2.5,
        fillColor: '#1c2333',
        fillOpacity: 1,
        className: 'start-marker',
        interactive: false   // 点击可穿透到地图，便于就近重新选点
      }).addTo(map);
    }
    startLabel.textContent = '已选择：' + lat.toFixed(5) + ', ' + lng.toFixed(5);
    startLabel.classList.add('is-set');
    clearRoutes();          // 起点变了，旧路线不再适用
    saveState();
  }

  function clearStart() {
    state.start = null;
    if (state.marker) {
      map.removeLayer(state.marker);
      state.marker = null;
    }
    startLabel.textContent = '在地图上点击选择出发点';
    startLabel.classList.remove('is-set');
    clearRoutes();
    saveState();
  }

  clearBtn.addEventListener('click', clearStart);

  locateBtn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      toast('当前浏览器不支持定位功能，请在地图上手动点选');
      return;
    }
    locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      locateBtn.disabled = false;
      // 浏览器定位是 WGS-84，转成 GCJ-02 才能与高德地图对齐
      var p = wgs84ToGcj02(pos.coords.latitude, pos.coords.longitude);
      setStart(p.lat, p.lng);
      map.setView([p.lat, p.lng], 13);
    }, function (err) {
      locateBtn.disabled = false;
      toast(err && err.code === 1
        ? '定位被拒绝：请在浏览器地址栏允许定位权限'
        : '定位失败，请在地图上手动点选出发点');
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  /* ---------------- 运动类型与距离 ---------------- */

  function readDistance() {
    var v = parseFloat(distNumber.value);
    return isFinite(v) && v > 0 ? v : 0;
  }

  function applyModeLimits() {
    var lim = MODE_LIMITS[state.mode];
    var cur = readDistance();
    var value = (cur >= lim.min && cur <= lim.max) ? cur : lim.def;
    distRange.min = distNumber.min = lim.min;
    distRange.max = distNumber.max = lim.max;
    distRange.value = value;
    distNumber.value = value;
    distMin.textContent = lim.min + ' km';
    distMax.textContent = lim.max + ' km';
  }

  function syncModeButtons() {
    [].forEach.call(modeSwitch.querySelectorAll('.seg'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-mode') === state.mode);
    });
  }

  modeSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.seg') : null;
    if (!btn) return;
    var mode = btn.getAttribute('data-mode');
    if (mode === state.mode) return;
    state.mode = mode;
    syncModeButtons();
    applyModeLimits();
    clearRoutes();          // 运动类型变了，旧路线不再适用
    saveState();
  });

  distRange.addEventListener('input', function () {
    distNumber.value = distRange.value;
  });

  distNumber.addEventListener('change', function () {
    var lim = MODE_LIMITS[state.mode];
    var v = readDistance();
    if (!v) {
      v = lim.def;
    } else if (v < lim.min || v > lim.max) {
      toast('距离需在 ' + lim.min + '–' + lim.max + ' km 之间');
      v = Math.min(lim.max, Math.max(lim.min, v));
    }
    distNumber.value = v;
    distRange.value = v;
    saveState();
  });

  /* ---------------- 提示与状态 ---------------- */

  var toastTimer = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 5000);
  }

  function setStatus(text) {
    if (text) {
      statusText.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    generateBtn.disabled = busy;
    generateBtn.textContent = busy ? '正在生成…' : '生成路线';
  }

  /* ---------------- 路线展示 ---------------- */

  function formatDuration(minutes) {
    if (minutes < 60) return Math.round(minutes) + ' 分钟';
    var h = Math.floor(minutes / 60);
    var m = Math.round(minutes % 60);
    return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
  }

  function clearRoutes() {
    state.routes.forEach(function (item) { map.removeLayer(item.line); });
    state.routes = [];
    state.selected = -1;
    cardsEl.innerHTML = '';
  }

  function renderRoutes(routes) {
    clearRoutes();

    state.routes = routes.map(function (r, i) {
      var color = COLORS[i % COLORS.length];
      var latlngs = r.points.map(function (p) { return [p.lat, p.lng]; });

      var line = L.polyline(latlngs, {
        color: color,
        weight: 5,
        opacity: 0.92,
        lineJoin: 'round',
        lineCap: 'round'
      }).addTo(map);
      line.on('click', function (e) {
        if (e.originalEvent) L.DomEvent.stopPropagation(e);
        select(i);
      });

      var km = r.distance / 1000;
      var devPct = (r.distance - state.targetKm * 1000) / (state.targetKm * 1000) * 100;
      var minutes = km / SPEED_KMH[state.mode] * 60;

      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.innerHTML =
        '<span class="card-dot" style="background:' + color + '"></span>' +
        '<span class="card-body">' +
          '<span class="card-top">' +
            '<span class="card-title">路线 ' + (i + 1) +
              (i === 0 ? '<span class="tag">最接近目标</span>' : '') +
            '</span>' +
            '<span class="card-dist">' + km.toFixed(1) + ' km</span>' +
          '</span>' +
          '<span class="card-meta">偏差 ' + (devPct >= 0 ? '+' : '') + devPct.toFixed(1) + '%' +
            ' · 约 ' + formatDuration(minutes) +
            (state.mode === 'run' ? '（按 10 km/h）' : '（按 18 km/h）') +
          '</span>' +
        '</span>';
      card.addEventListener('click', function () { select(i); });
      cardsEl.appendChild(card);

      return { line: line, card: card, color: color };
    });
  }

  /** 选中某条路线：高亮它、其余变淡；再次点击取消选中 */
  function select(idx) {
    state.selected = (state.selected === idx) ? -1 : idx;

    state.routes.forEach(function (item, i) {
      var isSel = state.selected === i;
      var dimmed = state.selected !== -1 && !isSel;
      item.line.setStyle({
        opacity: dimmed ? 0.12 : 0.92,
        weight: isSel ? 7 : 5
      });
      if (isSel) item.line.bringToFront();
      item.card.classList.toggle('is-active', isSel);
      item.card.style.borderColor = isSel ? item.color : '';
      item.card.style.background = isSel ? item.color + '14' : '';
    });
  }

  function fitToRoutes() {
    if (!state.routes.length) return;
    var group = L.featureGroup(state.routes.map(function (item) { return item.line; }));
    var bounds = group.getBounds();
    if (!bounds.isValid()) return;

    // 面板遮挡区域留白：宽屏时面板在左，窄屏时面板在下方
    var narrow = window.innerWidth <= 560;
    if (narrow) {
      // 底部抽屉高度随卡片数量变化，直接量它的实际顶边，避免路线被抽屉遮住
      var panelTop = $('panel').getBoundingClientRect().top;
      var bottomPad = Math.max(140, Math.round(window.innerHeight - panelTop) + 12);
      map.fitBounds(bounds, {
        paddingTopLeft: [20, 20],
        paddingBottomRight: [20, bottomPad]
      });
    } else {
      map.fitBounds(bounds, {
        paddingTopLeft: [372, 36],
        paddingBottomRight: [36, 36]
      });
    }
  }

  /* ---------------- 生成流程 ---------------- */

  function generate() {
    if (state.busy) return;

    if (!state.start) {
      toast('请先在地图上点击选择出发点');
      return;
    }
    var km = readDistance();
    var lim = MODE_LIMITS[state.mode];
    if (!km || km < lim.min || km > lim.max) {
      toast('请输入 ' + lim.min + '–' + lim.max + ' km 之间的目标距离');
      return;
    }

    setBusy(true);
    setStatus('正在规划路线…');
    clearRoutes();

    LoopGen.generateLoops({
      start: state.start,
      targetKm: km,
      mode: state.mode,
      count: 3,
      routeFn: AmapRouter.planLeg,
      onProgress: function (n, msg) { setStatus(msg); }
    }).then(function (routes) {
      state.targetKm = km;
      renderRoutes(routes);
      fitToRoutes();
      if (routes.length < 3) {
        toast('本次只生成了 ' + routes.length + ' 条路线，可再点一次「生成路线」换一批');
      }
    }).catch(function (err) {
      toast(err && err.message ? err.message : '生成失败，请稍后重试');
    }).then(function () {
      setBusy(false);
      setStatus('');
    });
  }

  generateBtn.addEventListener('click', generate);

  /* ---------------- 记住上次的选择 ---------------- */

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: state.mode,
        start: state.start,
        distance: readDistance()
      }));
    } catch (e) { /* 隐私模式等场景下忽略 */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  (function init() {
    var saved = loadState();
    if (saved && MODE_LIMITS[saved.mode]) state.mode = saved.mode;
    syncModeButtons();
    applyModeLimits();

    if (saved && isFinite(saved.distance) && saved.distance > 0) {
      var lim = MODE_LIMITS[state.mode];
      if (saved.distance >= lim.min && saved.distance <= lim.max) {
        distRange.value = saved.distance;
        distNumber.value = saved.distance;
      }
    }

    if (saved && saved.start && isFinite(saved.start.lat) && isFinite(saved.start.lng)) {
      setStart(saved.start.lat, saved.start.lng);
      map.setView([saved.start.lat, saved.start.lng], 12);
    }
  })();
})();
