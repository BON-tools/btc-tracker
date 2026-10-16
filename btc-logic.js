/*
 * BTC 雙線監控 — 核心判斷邏輯
 * 網頁儀表板（index.html）與 Telegram 機器人（bot/bot.js）共用這一份，兩邊訊號一定一致。
 *
 * 兩條關鍵線：日線 MA360、週線 MA50
 * 週線以每週一 00:00 UTC（台灣時間週一早上 8 點）為一根，與 Binance 相同。
 */
(function (root) {
  'use strict';

  var DAY = 86400000;

  // 預設參數（網頁的「參數設定」可以改）
  var DEFAULTS = {
    dMaLen: 360,          // 日線均線長度
    wMaLen: 50,           // 週線均線長度
    daysAboveMin: 14,     // 「站上一陣子」= 連續站上兩線至少幾天
    nearPct: 5,           // 「回撤到線附近」= 價格距離較近那條線幾 % 以內
    dSlopeDays: 10,       // 日MA360「上揚」= 比幾天前高
    wSlopeWeeks: 2,       // 週MA50「上揚」= 比幾週前高
    stopBufferPct: 5,     // 止損設在兩線中較低那條再往下幾 %
    mmrPct: 0.4,          // 維持保證金率 %（Binance BTCUSDT 第一級約 0.4%）
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    pivotSpan: 4,         // 週線波段高點：左右各幾週都比它低
    divRecentWeeks: 6,    // 最近幾週內出現新高才檢查背離
    divLookbackWeeks: 104,// 往回找前一個波段高點的範圍（週）
    divMinGapWeeks: 8,    // 兩個高點至少相隔幾週
    fibWeeks: 156,        // 斐波那契取最近幾週的高低點
    confirmDays: 3,
    accWeeks: 8,          // 吸籌區：看最近幾週
    accRangePct: 25,      // 吸籌區：這段期間最高與最低相差幾 % 以內 = 橫盤
    accDrawdownPct: 45,   // 吸籌區：價格距歷史高點至少跌了幾 % = 低位
    accMinDays: 14,       // 吸籌區：連續符合幾天才算
    accAfterDays: 56,     // 吸籌區結束（突破）後幾天內，回踩雙線仍算「吸籌區回踩」       // 歷史事件：站上/跌破後要連續停留幾天才算數
    divMemoryWeeks: 26,   // 頂背離出現後幾週內，開多訊號要加上警告
    similarExcludeDays: 180, // 歷史對照：排除最近幾天（才看得到後續漲跌）
    similarGapDays: 120   // 歷史對照：挑出的相似日期彼此至少相隔幾天
  };

  /* ---------- 基本指標 ---------- */

  function sma(arr, len) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= len) sum -= arr[i - len];
      if (i >= len - 1) out[i] = sum / len;
    }
    return out;
  }

  function ema(arr, len) {
    var out = new Array(arr.length).fill(null), k = 2 / (len + 1), prev = null, n = 0, sum = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      if (prev == null) {
        sum += v; n++;
        if (n === len) { prev = sum / len; out[i] = prev; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function macd(closes, f, s, g) {
    var ef = ema(closes, f), es = ema(closes, s);
    var dif = closes.map(function (_, i) { return ef[i] != null && es[i] != null ? ef[i] - es[i] : null; });
    var dea = ema(dif, g);
    var hist = dif.map(function (v, i) { return v != null && dea[i] != null ? (v - dea[i]) * 2 : null; });
    return { dif: dif, dea: dea, hist: hist };
  }

  function weekStart(t) {
    var day0 = Math.floor(t / DAY) * DAY;
    var dow = new Date(day0).getUTCDay();
    return day0 - ((dow + 6) % 7) * DAY;
  }

  function toWeekly(daily) {
    var weeks = [], idxOfDay = new Array(daily.length);
    for (var i = 0; i < daily.length; i++) {
      var c = daily[i], ws = weekStart(c.t), w = weeks[weeks.length - 1];
      if (!w || w.t !== ws) {
        w = { t: ws, o: c.o, h: c.h, l: c.l, c: c.c, first: i, last: i };
        weeks.push(w);
      } else {
        if (c.h > w.h) w.h = c.h;
        if (c.l < w.l) w.l = c.l;
        w.c = c.c; w.last = i;
      }
      idxOfDay[i] = weeks.length - 1;
    }
    return { weeks: weeks, idxOfDay: idxOfDay };
  }

  /* ---------- 主分析 ---------- */

  function analyze(daily, params) {
    var p = Object.assign({}, DEFAULTS, params || {});
    var n = daily.length;
    var closes = daily.map(function (c) { return c.c; });
    var dMA = sma(closes, p.dMaLen);

    var wk = toWeekly(daily), weeks = wk.weeks;
    var wCloses = weeks.map(function (w) { return w.c; });
    var wMA = sma(wCloses, p.wMaLen);

    // 每一天「當下看到的」週MA50（本週用當天收盤當作本週收盤，不偷看未來）
    var prefix = [0];
    for (var j = 0; j < wCloses.length; j++) prefix.push(prefix[j] + wCloses[j]);
    var wMAd = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      var wj = wk.idxOfDay[i];
      if (wj >= p.wMaLen - 1) {
        var prevSum = prefix[wj] - prefix[wj - (p.wMaLen - 1)];
        wMAd[i] = (prevSum + closes[i]) / p.wMaLen;
      }
    }

    // 每日狀態
    var day = new Array(n).fill(null), run = 0;
    for (i = 0; i < n; i++) {
      var c = closes[i], a = dMA[i], b = wMAd[i];
      if (a == null || b == null) { run = 0; continue; }
      var aboveD = c > a, aboveW = c > b;
      var aboveBoth = aboveD && aboveW, belowBoth = !aboveD && !aboveW;
      run = aboveBoth ? run + 1 : 0;
      var ia = i - p.dSlopeDays, ib = i - 7 * p.wSlopeWeeks;
      var dRising = ia >= 0 && dMA[ia] != null && a > dMA[ia];
      var wRising = ib >= 0 && wMAd[ib] != null && b > wMAd[ib];
      var distD = (c - a) / a * 100, distW = (c - b) / b * 100;
      var near = aboveBoth && Math.min(distD, distW) <= p.nearPct;
      var conds = {
        aboveBoth: aboveBoth,
        stayed: run >= p.daysAboveMin,
        dRising: dRising,
        wRising: wRising,
        near: near
      };
      var met = 0;
      for (var key in conds) if (conds[key]) met++;
      day[i] = {
        i: i, t: daily[i].t, c: c, dMA: a, wMA: b,
        aboveD: aboveD, aboveW: aboveW, aboveBoth: aboveBoth, belowBoth: belowBoth,
        daysAbove: run, dRising: dRising, wRising: wRising,
        distD: distD, distW: distW, near: near,
        conds: conds, condsMet: met, entry: met === 5,
        zone: aboveBoth ? 'hold' : belowBoth ? 'out' : 'mid',
        addAllowed: aboveBoth && dRising && wRising
      };
    }

    // 週線 MACD 與頂背離
    var m = macd(wCloses, p.macdFast, p.macdSlow, p.macdSignal);
    var pivots = [];
    for (j = p.pivotSpan; j < weeks.length - p.pivotSpan; j++) {
      if (m.dif[j] == null) continue;
      var h = weeks[j].h, ok = true;
      for (var k = j - p.pivotSpan; k <= j + p.pivotSpan && ok; k++) {
        if (k === j) continue;
        if (k < j && weeks[k].h >= h) ok = false;
        if (k > j && weeks[k].h > h) ok = false;
      }
      if (ok) pivots.push(j);
    }

    function prevPeak(idx) {
      var best = -1;
      for (var q = 0; q < pivots.length; q++) {
        var pj = pivots[q];
        if (pj > idx - p.divMinGapWeeks) break;
        if (pj < idx - p.divLookbackWeeks) continue;
        if (best < 0 || weeks[pj].h > weeks[best].h) best = pj;
      }
      return best;
    }

    function isDivergence(idx, prev) {
      return prev >= 0 && m.dif[idx] != null && m.dif[prev] != null &&
        m.dif[prev] > 0 && weeks[idx].h > weeks[prev].h && m.dif[idx] < m.dif[prev];
    }

    var divergences = [];
    pivots.forEach(function (pj) {
      var pv = prevPeak(pj);
      if (isDivergence(pj, pv)) divergences.push({ idx: pj, prev: pv, t: weeks[pj].t, h: weeks[pj].h, prevT: weeks[pv].t, prevH: weeks[pv].h, dif: m.dif[pj], prevDif: m.dif[pv] });
    });

    var W = weeks.length, divNow = { active: false };
    if (W > 0) {
      var start = Math.max(0, W - p.divRecentWeeks), cand = start;
      for (j = start; j < W; j++) if (weeks[j].h > weeks[cand].h) cand = j;
      var pv = prevPeak(cand);
      divNow = {
        active: isDivergence(cand, pv),
        cand: cand, prev: pv,
        candT: weeks[cand].t, candH: weeks[cand].h, candDif: m.dif[cand],
        prevT: pv >= 0 ? weeks[pv].t : null, prevH: pv >= 0 ? weeks[pv].h : null, prevDif: pv >= 0 ? m.dif[pv] : null,
        newHigh: pv >= 0 && weeks[cand].h > weeks[pv].h
      };
    }

    // 吸籌區 + 壓回雙線附近：吸籌區期間或結束後 accAfterDays 天內，價格回到任一條線 nearPct% 以內
    var acc = accumulation(daily, weeks, wk.idxOfDay, p), accPulls = [], prevOn = false;
    function accZoneAt(t) {
      for (var q = acc.zones.length - 1; q >= 0; q--) {
        var z = acc.zones[q];
        if (t >= z.fromT && t <= z.toT + p.accAfterDays * DAY) return z;
      }
      return null;
    }
    for (i = 0; i < n; i++) {
      var dd2 = day[i];
      if (!dd2) { prevOn = false; continue; }
      var z2 = accZoneAt(dd2.t);
      var nearAny = Math.abs(dd2.distD) <= p.nearPct || Math.abs(dd2.distW) <= p.nearPct;
      dd2.accZone = z2; dd2.accPull = !!z2 && nearAny;
      if (dd2.accPull && !prevOn) accPulls.push({ t: dd2.t, i: i, price: dd2.c, rising: dd2.dRising && dd2.wRising });
      prevOn = dd2.accPull;
    }

    // 最近是否出現過頂背離（開多訊號要打折）
    var lastDiv = divergences.length ? divergences[divergences.length - 1] : null;
    var divRecent = divNow.active || (lastDiv != null && lastDiv.idx >= W - 1 - p.divMemoryWeeks);

    var last = day[n - 1];
    var stop = last ? Math.min(last.dMA, last.wMA) * (1 - p.stopBufferPct / 100) : null;

    return {
      params: p, daily: daily, weeks: weeks, idxOfDay: wk.idxOfDay,
      dMA: dMA, wMA: wMA, wMAd: wMAd, macd: m, day: day, last: last,
      pivots: pivots, divergences: divergences, divNow: divNow, divRecent: divRecent, lastDiv: lastDiv,
      stop: stop,
      exit: last ? { divergence: divNow.active, belowBoth: last.belowBoth, belowAny: !last.aboveBoth } : null,
      fib: fibonacci(weeks, p.fibWeeks),
      acc: acc,
      accPullbacks: accPulls,
      events: crossEvents(day, closes, p.confirmDays),
      similar: similarDays(day, dMA, wMAd, closes, p)
    };
  }

  /* ---------- 斐波那契 ---------- */

  function fibonacci(weeks, span) {
    if (weeks.length < 10) return null;
    var s = Math.max(0, weeks.length - span), hi = s, lo = s;
    for (var j = s; j < weeks.length; j++) if (weeks[j].h > weeks[hi].h) hi = j;
    // 低點取高點之前的最低點（上漲波段）；若高點就在最前面，改取之後的最低點
    var from = s, to = hi;
    if (hi === s) { from = hi; to = weeks.length - 1; }
    lo = from;
    for (j = from; j <= to; j++) if (weeks[j].l < weeks[lo].l) lo = j;
    var H = weeks[hi].h, L = weeks[lo].l, R = H - L;
    var up = lo < hi; // 低點在前 = 上漲波段，從高點往下算回撤
    var ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    var levels = ratios.map(function (r) {
      return { ratio: r, price: up ? H - R * r : L + R * r };
    });
    var ext = [1.272, 1.618].map(function (r) {
      return { ratio: r, price: up ? L + R * r : H - R * r, ext: true };
    });
    return { high: H, low: L, highT: weeks[hi].t, lowT: weeks[lo].t, up: up, levels: levels, ext: ext };
  }

  /* ---------- 低點橫盤吸籌區 ----------
   * 條件：價格距歷史高點跌了 accDrawdownPct% 以上（低位），
   *       且最近 accWeeks 週的最高/最低相差不到 accRangePct%（橫盤），連續 accMinDays 天。
   * 歷史上常出現在主升段之前（2015、2016、2019、2023），但也有再破底的例子（2018/10、2022/9）。 */
  function accumulation(daily, weeks, idxOfDay, p) {
    var n = daily.length, ath = 0, flags = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (daily[i].h > ath) ath = daily[i].h;
      var wj = idxOfDay[i];
      if (wj < p.accWeeks - 1) continue;
      var hi = -Infinity, lo = Infinity;
      for (var k = wj - p.accWeeks + 1; k <= wj; k++) { if (weeks[k].h > hi) hi = weeks[k].h; if (weeks[k].l < lo) lo = weeks[k].l; }
      var range = (hi / lo - 1) * 100, dd = (1 - daily[i].c / ath) * 100;
      if (range <= p.accRangePct && dd >= p.accDrawdownPct) flags[i] = { hi: hi, lo: lo, range: range, dd: dd, from: weeks[wj - p.accWeeks + 1].t };
    }
    var zones = [], start = -1;
    for (i = 0; i <= n; i++) {
      var f = i < n ? flags[i] : null;
      if (f && start < 0) start = i;
      if (!f && start >= 0) {
        if (i - start >= p.accMinDays) {
          var zhi = -Infinity, zlo = Infinity, from = flags[start].from;
          for (var j = 0; j < n && daily[j].t <= daily[i - 1].t; j++) {
            if (daily[j].t < from) continue;
            if (daily[j].h > zhi) zhi = daily[j].h; if (daily[j].l < zlo) zlo = daily[j].l;
          }
          zones.push({ fromT: from, toT: daily[i - 1].t, hi: zhi, lo: zlo, ongoing: i === n, days: i - start });
        }
        start = -1;
      }
    }
    var cur = flags[n - 1];
    var curRun = 0;
    for (i = n - 1; i >= 0 && flags[i]; i--) curRun++;
    return {
      zones: zones,
      active: !!cur && curRun >= p.accMinDays,
      forming: !!cur && curRun < p.accMinDays,
      now: cur ? { hi: cur.hi, lo: cur.lo, range: cur.range, dd: cur.dd, fromT: cur.from, days: curRun } : null
    };
  }

  /* ---------- 歷史：站上 / 跌破兩線事件 ---------- */

  // 價格在新區域連續停留 confirm 天才算一次「站上 / 跌破」，避免在線附近來回洗的雜訊
  function crossEvents(day, closes, confirm) {
    var events = [], lastZone = null, zone = null, streak = 0, start = -1;
    for (var i = 0; i < day.length; i++) {
      var d = day[i];
      if (!d) continue;
      if (d.zone === zone) streak++; else { zone = d.zone; streak = 1; start = i; }
      if (zone !== 'mid' && streak === confirm) {
        if (lastZone !== null && zone !== lastZone) {
          events.push({ t: day[start].t, i: start, type: zone, price: closes[start], fwd: fwd(closes, start) });
        }
        lastZone = zone;
      }
    }
    return events;
  }

  function fwd(closes, i) {
    function r(k) { return i + k < closes.length ? (closes[i + k] / closes[i] - 1) * 100 : null; }
    return { d30: r(30), d90: r(90), d180: r(180) };
  }

  /* ---------- 歷史：最相似的位置 ---------- */

  function similarDays(day, dMA, wMAd, closes, p) {
    var n = day.length, last = day[n - 1];
    if (!last) return [];
    function feat(i) {
      if (!day[i] || i < 30 || dMA[i - 30] == null || wMAd[i - 28] == null) return null;
      return [
        Math.log(closes[i] / dMA[i]),
        Math.log(closes[i] / wMAd[i]),
        dMA[i] / dMA[i - 30] - 1,
        wMAd[i] / wMAd[i - 28] - 1
      ];
    }
    var rows = [];
    for (var i = 0; i < n; i++) { var f = feat(i); if (f) rows.push({ i: i, f: f }); }
    var cur = feat(n - 1);
    if (!cur || rows.length < 50) return [];
    var mean = [0, 0, 0, 0], sd = [0, 0, 0, 0];
    rows.forEach(function (r) { for (var k = 0; k < 4; k++) mean[k] += r.f[k] / rows.length; });
    rows.forEach(function (r) { for (var k = 0; k < 4; k++) sd[k] += Math.pow(r.f[k] - mean[k], 2) / rows.length; });
    sd = sd.map(function (v) { return Math.sqrt(v) || 1; });
    var cand = rows.filter(function (r) { return r.i <= n - 1 - p.similarExcludeDays; }).map(function (r) {
      var d = 0;
      for (var k = 0; k < 4; k++) d += Math.pow((r.f[k] - cur[k]) / sd[k], 2);
      return { i: r.i, dist: Math.sqrt(d) };
    }).sort(function (a, b) { return a.dist - b.dist; });
    var picked = [];
    for (var q = 0; q < cand.length && picked.length < 3; q++) {
      var c = cand[q];
      if (picked.every(function (x) { return Math.abs(x.i - c.i) >= p.similarGapDays; })) picked.push(c);
    }
    return picked.map(function (c) {
      var d = day[c.i];
      return { t: d.t, i: c.i, price: d.c, dist: c.dist, distD: d.distD, distW: d.distW, dRising: d.dRising, wRising: d.wRising, zone: d.zone, fwd: fwd(closes, c.i) };
    });
  }

  /* ---------- 強平價（逐倉多單估算，不含手續費與資金費） ---------- */

  function liqLong(entry, lev, mmrPct) {
    return entry * (1 - 1 / lev + mmrPct / 100);
  }

  // 要讓強平價低於 target，槓桿最多幾倍
  function maxLeverage(entry, target, mmrPct) {
    var d = 1 + mmrPct / 100 - target / entry;
    return d > 0 ? 1 / d : Infinity;
  }

  /* ---------- 抓資料（瀏覽器與 Node 18+ 都能用） ---------- */

  function getJson(url, fetchImpl) {
    return fetchImpl(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchBinanceDaily(base, fetchImpl) {
    var out = [], start = Date.UTC(2017, 7, 17);
    function page(k) {
      var url = base + '/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000&startTime=' + start;
      return getJson(url, fetchImpl).then(function (rows) {
        rows.forEach(function (r) { out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }); });
        if (rows.length < 1000 || k >= 12) return out;
        start = rows[rows.length - 1][0] + DAY;
        return page(k + 1);
      });
    }
    return page(0);
  }

  function fetchCoinbaseDaily(fetchImpl) {
    var end = Math.floor(Date.now() / DAY) * DAY + DAY, out = [], seen = {};
    function page(k) {
      var e = end - k * 300 * DAY, s = e - 300 * DAY;
      var url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=' +
        new Date(s).toISOString() + '&end=' + new Date(e).toISOString();
      return getJson(url, fetchImpl).then(function (rows) {
        rows.forEach(function (r) {
          var t = r[0] * 1000;
          if (!seen[t]) { seen[t] = 1; out.push({ t: t, o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] }); }
        });
        if (!rows.length || k >= 12) return out.sort(function (a, b) { return a.t - b.t; });
        return page(k + 1);
      });
    }
    return page(0);
  }

  // 依序嘗試資料來源，第一個成功的就用
  function fetchDaily(fetchImpl) {
    fetchImpl = fetchImpl || root.fetch.bind(root);
    var sources = [
      { name: 'Binance', run: function () { return fetchBinanceDaily('https://data-api.binance.vision', fetchImpl); } },
      { name: 'Binance', run: function () { return fetchBinanceDaily('https://api.binance.com', fetchImpl); } },
      { name: 'Coinbase', run: function () { return fetchCoinbaseDaily(fetchImpl); } }
    ];
    var errors = [];
    function tryAt(k) {
      if (k >= sources.length) return Promise.reject(new Error('所有資料來源都失敗：' + errors.join('；')));
      return sources[k].run().then(function (daily) {
        if (daily.length < 800) throw new Error(sources[k].name + ' 資料太少');
        return { source: sources[k].name, daily: daily };
      }).catch(function (e) { errors.push(e.message); return tryAt(k + 1); });
    }
    return tryAt(0);
  }

  // 籌碼參考（Binance 合約公開資料；抓不到就回傳 null）
  function fetchChips(fetchImpl) {
    fetchImpl = fetchImpl || root.fetch.bind(root);
    var B = 'https://fapi.binance.com';
    function safe(pr) { return pr.catch(function () { return null; }); }
    return Promise.all([
      safe(getJson(B + '/fapi/v1/premiumIndex?symbol=BTCUSDT', fetchImpl)),
      safe(getJson(B + '/fapi/v1/fundingRate?symbol=BTCUSDT&limit=90', fetchImpl)),
      safe(getJson(B + '/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30', fetchImpl)),
      safe(getJson(B + '/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=30', fetchImpl)),
      safe(getJson(B + '/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1d&limit=30', fetchImpl))
    ]).then(function (r) {
      var out = { funding: null, funding30: null, oi: null, oiChange30: null, ls: null, lsTop: null };
      if (r[0]) out.funding = +r[0].lastFundingRate * 100;
      if (r[1] && r[1].length) {
        var lastN = r[1].slice(-90);
        out.funding30 = lastN.reduce(function (s, x) { return s + +x.fundingRate; }, 0) / lastN.length * 100;
      }
      if (r[2] && r[2].length) {
        var first = +r[2][0].sumOpenInterestValue, lastV = +r[2][r[2].length - 1].sumOpenInterestValue;
        out.oi = lastV; out.oiChange30 = (lastV / first - 1) * 100;
        out.oiSeries = r[2].map(function (x) { return +x.sumOpenInterestValue; });
      }
      if (r[3] && r[3].length) out.ls = +r[3][r[3].length - 1].longShortRatio;
      if (r[4] && r[4].length) out.lsTop = +r[4][r[4].length - 1].longShortRatio;
      var any = false;
      for (var k in out) if (out[k] != null) any = true;
      return any ? out : null;
    });
  }

  var api = {
    DEFAULTS: DEFAULTS, DAY: DAY,
    sma: sma, ema: ema, macd: macd, toWeekly: toWeekly, weekStart: weekStart,
    analyze: analyze, fibonacci: fibonacci,
    liqLong: liqLong, maxLeverage: maxLeverage,
    fetchDaily: fetchDaily, fetchChips: fetchChips
  };

  root.BTCLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
