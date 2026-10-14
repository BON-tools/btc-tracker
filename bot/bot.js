#!/usr/bin/env node
/*
 * BTC 雙線監控 — Telegram 推播機器人
 * 由 GitHub Actions 每天台灣時間早上 8:10 執行一次（日K 收盤後）。
 *
 * 會推播的情況：
 *   1. 訊號有變化（站上/跌破任一條線、開多條件成立/失效、週MACD 頂背離、浮盈加倉許可改變、回撤到線附近）
 *   2. 每週一早上的週報
 *   3. 手動執行（Actions 頁面按 Run workflow）時一定會發一份現況
 *   4. 有設定 LIQ_PRICE（你的強平價）時，強平價跑到兩線之上、或價格逼近強平價
 *
 * 需要的設定（GitHub → Settings → Secrets and variables → Actions）：
 *   Secret  TELEGRAM_BOT_TOKEN   新機器人的 token（向 @BotFather 申請）
 *   Secret  TELEGRAM_CHAT_ID     你的 Chat ID（第一次執行時機器人會傳給你）
 *   Variable LIQ_PRICE           （選填）目前合約多單的強平價
 *   Variable DAILY_SUMMARY       （選填）填 true = 每天都發現況，不只週一
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('../btc-logic.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.STATE_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SNAP_FILE = path.join(DATA_DIR, 'snapshot.json');

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();
const FORCE = process.env.FORCE_SUMMARY === 'true';
const DAILY = (process.env.DAILY_SUMMARY || '').trim().toLowerCase() === 'true';
const DASH = (process.env.DASHBOARD_URL || '').trim();
const LIQ = parseFloat(process.env.LIQ_PRICE || '');
const DRY = process.argv.includes('--dry');         // 測試用：只印出訊息不發送
const inputIdx = process.argv.indexOf('--input');   // 測試用：從檔案讀價格資料

/* ---------- 小工具 ---------- */
const usd = v => v == null || !isFinite(v) ? '—' : '$' + Math.round(v).toLocaleString('en-US');
const pct = (v, d = 1) => v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
const taipei = (t = Date.now()) => new Date(t + 8 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method} 失敗：${j.description}`);
  return j.result;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/* ---------- 第一次設定：還沒有 Chat ID ---------- */
async function sendChatIdHelp() {
  const ups = await tg('getUpdates', {});
  const chats = new Set(ups.map(u => ((u.message || u.channel_post || {}).chat || {}).id).filter(Boolean));
  if (!chats.size) {
    console.log('還沒有人傳訊息給機器人。請先在 Telegram 打開你的新機器人，按「開始」或傳一句 hi，再重新執行一次。');
    return;
  }
  for (const id of chats) {
    await tg('sendMessage', {
      chat_id: id,
      text: `你好！你的 Chat ID 是：${id}\n\n請到 GitHub 專案 → Settings → Secrets and variables → Actions → New repository secret：\n名稱：TELEGRAM_CHAT_ID\n內容：${id}\n\n加好之後到 Actions 頁面再執行一次，就會開始推播。`
    });
  }
  console.log('已經把 Chat ID 傳到 Telegram，請照訊息指示設定。');
}

/* ---------- 比較前後狀態，找出變化 ---------- */
function snapshotState(res) {
  const x = res.last;
  return {
    date: ymd(new Date(x.t)),
    zone: x.zone, aboveD: x.aboveD, aboveW: x.aboveW,
    entry: x.entry, divActive: res.divNow.active, addAllowed: x.addAllowed,
    near: x.near,
    liqOk: isFinite(LIQ) ? LIQ < Math.min(x.dMA, x.wMA) : null
  };
}

function diffEvents(prev, cur, res) {
  const x = res.last, ev = [];
  if (!prev) return ev;

  if (prev.aboveD !== cur.aboveD) ev.push(cur.aboveD ? `📈 站上日MA360（${usd(x.dMA)}）` : `📉 跌破日MA360（${usd(x.dMA)}）`);
  if (prev.aboveW !== cur.aboveW) ev.push(cur.aboveW ? `📈 站上週MA50（${usd(x.wMA)}）` : `📉 跌破週MA50（${usd(x.wMA)}）`);
  if (prev.zone !== cur.zone) {
    // 記錄最近的區域變化，7 天內來回多次 = 在線附近洗盤
    const today = Date.parse(cur.date);
    cur.flips = (prev.flips || []).concat(cur.date).filter(d => today - Date.parse(d) <= 7 * L.DAY).slice(-10);
    if (cur.zone === 'hold') ev.push('✅ <b>同時站上兩條線</b>：現貨傻瓜法「買進」訊號');
    else if (cur.zone === 'out') ev.push('🔴 <b>兩條線都跌破</b>：現貨傻瓜法「賣出」、合約多單出場（延後指標）');
    else if (prev.zone === 'hold') ev.push('⚠️ 跌破其中一條線，還剩一條撐著，留意');
    if (cur.flips.length >= 3) {
      ev.push(`🌀 最近 7 天已經來回 ${cur.flips.length} 次，價格正在線附近反覆洗盤。莊家視角：這是在洗掉兩邊的人，建議等連續幾天收盤確認再動作`);
    }
  } else {
    cur.flips = (prev.flips || []).filter(d => Date.parse(cur.date) - Date.parse(d) <= 7 * L.DAY);
  }

  if (!prev.entry && cur.entry) {
    ev.push('🟢 <b>合約開多條件 5 項全部符合</b>' +
      (res.divRecent ? '\n　⚠️ 但近半年出現過週MACD 頂背離，高檔要特別小心' : '') +
      `\n　建議止損：${usd(res.stop)}`);
  } else if (prev.entry && !cur.entry) {
    ev.push('⚪ 開多條件不再全部符合：' + failedConds(res).join('、'));
  }

  if (!prev.near && cur.near && !cur.entry) {
    ev.push(`👀 價格回撤到線附近（距較近的線 ${pct(Math.min(x.distD, x.distW))}），但開多條件還沒全部符合`);
  }

  if (!prev.divActive && cur.divActive) {
    const d = res.divNow;
    ev.push(`🚨 <b>週MACD 頂背離出現</b>（敏感出場指標）\n　本波高點 ${usd(d.candH)} 高於前高 ${usd(d.prevH)}，但 MACD 沒有創高`);
  }

  if (prev.addAllowed !== cur.addAllowed) {
    ev.push(cur.addAllowed ? '🟩 浮盈加倉：現在<b>允許</b>（兩線上揚、價格在線上，有保護線）' : '🟥 浮盈加倉：現在<b>禁止</b>');
  }

  if (cur.liqOk === false && prev.liqOk !== false) {
    ev.push(`❗ 你的強平價 ${usd(LIQ)} 已經在兩條線之上，違反原則 5️⃣`);
  }
  return ev;
}

function failedConds(res) {
  const c = res.last.conds, names = {
    aboveBoth: '價格不在兩線之上', stayed: '站上天數不足', dRising: '日MA360 沒上揚',
    wRising: '週MA50 沒上揚', near: '價格離線太遠'
  };
  return Object.keys(names).filter(k => !c[k]).map(k => names[k]);
}

/* ---------- 組訊息 ---------- */
function buildMessage(res, events, source, title) {
  const x = res.last, d = res.daily, n = d.length;
  const chg = n > 1 ? (d[n - 1].c / d[n - 2].c - 1) * 100 : null;
  const zone = x.zone === 'hold' ? '持有區（站上兩線）' : x.zone === 'out' ? '空手區（跌破兩線）' : '觀望區（兩線之間）';
  const exit = res.divNow.active ? '🚨 週MACD 頂背離' : x.belowBoth ? '🔴 已跌破兩線' : !x.aboveBoth ? '⚠️ 跌破一條' : '無';
  const lines = [];
  lines.push(`<b>${title}｜${ymd(taipei())}</b>`);
  lines.push(`BTC ${usd(x.c)}（${pct(chg, 2)}）`);
  if (events.length) {
    lines.push('', '<b>🔔 訊號變化</b>');
    events.forEach(e => lines.push('• ' + e));
  }
  lines.push('', '<b>目前狀態</b>');
  lines.push(`現貨傻瓜法：${zone}`);
  lines.push(`合約開多：${x.entry ? '✅ 符合' : `符合 ${x.condsMet}/5`}${x.entry ? '' : '（缺：' + failedConds(res).join('、') + '）'}`);
  lines.push(`出場警報：${exit}`);
  lines.push(`浮盈加倉：${x.addAllowed ? '允許' : '禁止'}`);
  lines.push('');
  lines.push(`日MA360 ${usd(x.dMA)}（價差 ${pct(x.distD)}，${x.dRising ? '上揚' : '下彎'}）`);
  lines.push(`週MA50　${usd(x.wMA)}（價差 ${pct(x.distW)}，${x.wRising ? '上揚' : '下彎'}）`);
  if (x.aboveBoth) {
    lines.push(`連續站上兩線：${x.daysAbove} 天`);
    lines.push(`建議止損：${usd(res.stop)}`);
  }
  if (isFinite(LIQ)) {
    const lower = Math.min(x.dMA, x.wMA);
    lines.push(`你的強平價：${usd(LIQ)}（${LIQ < lower ? '✅ 在兩線下方' : '❌ 在兩線之上'}，距現價 ${pct((LIQ / x.c - 1) * 100)}）`);
  }
  lines.push('');
  lines.push(`<i>資料來源：${source}。僅供參考，不構成投資建議。</i>`);
  if (DASH) lines.push(`<a href="${DASH}">打開儀表板</a>`);
  return lines.join('\n');
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!DRY && !TOKEN) {
    throw new Error('找不到 TELEGRAM_BOT_TOKEN。請到 GitHub → Settings → Secrets and variables → Actions 新增。');
  }
  if (!DRY && !CHAT) { await sendChatIdHelp(); return; }

  let daily, source;
  if (inputIdx > 0) {
    daily = JSON.parse(fs.readFileSync(process.argv[inputIdx + 1], 'utf8'));
    source = '測試資料';
  } else {
    const r = await L.fetchDaily(fetch);
    daily = r.daily; source = r.source;
  }

  const res = L.analyze(daily);
  if (!res.last) throw new Error('資料不足，算不出日MA360');

  const prevState = readJson(STATE_FILE);
  const cur = snapshotState(res);
  const events = diffEvents(prevState, cur, res);

  // 價格逼近強平價（10% 以內）：每次都提醒
  if (isFinite(LIQ) && res.last.c <= LIQ * 1.10) {
    events.unshift(`🆘 <b>價格距離你的強平價只剩 ${pct((LIQ / res.last.c - 1) * 100)}</b>`);
  }

  const now = taipei();
  const isMonday = now.getUTCDay() === 1;
  const alreadySummarized = prevState && prevState.lastSummary === ymd(now);
  let title = null;
  if (events.length) title = 'BTC 訊號提醒';
  else if (!prevState) title = 'BTC 監控已啟動';
  else if (FORCE) title = 'BTC 現況';
  else if ((isMonday || DAILY) && !alreadySummarized) title = isMonday ? 'BTC 週報' : 'BTC 日報';

  if (title) {
    const msg = buildMessage(res, events, source, title);
    if (DRY) console.log(msg.replace(/<[^>]+>/g, ''));
    else await tg('sendMessage', { chat_id: CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true });
    cur.lastSummary = ymd(now);
    console.log(`已發送：${title}（${events.length} 個訊號變化）`);
  } else {
    console.log('今天沒有訊號變化，不發送。');
  }
  if (!cur.lastSummary && prevState && prevState.lastSummary) cur.lastSummary = prevState.lastSummary;

  // 存狀態，給明天比較；存最近 1500 天資料，給網頁在連不上 Binance 時備用
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(cur, null, 2) + '\n');
  const rows = daily.slice(-1500).map(c => [c.t, Math.round(c.o), Math.round(c.h), Math.round(c.l), Math.round(c.c)]);
  fs.writeFileSync(SNAP_FILE, JSON.stringify({ source, updated: new Date().toISOString(), rows }));
}

main().catch(e => {
  console.error('執行失敗：' + e.message);
  process.exit(1);
});
