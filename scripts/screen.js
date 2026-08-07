// 決算ピックアップ 自動実行スクリプト(GitHub Actions用)
// ブラウザ版(index.html)と同じロジックをNode.js向けに移植したもの。
// サーバー側実行のためCORSの制約がなく、Cloudflare Workerプロキシは不要。

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.JQUANTS_API_KEY;
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD) || 3;
const MAX_COUNT = Number(process.env.MAX_COUNT) || 500;
const MIN_VOLUME = Number(process.env.MIN_VOLUME) || 10000;
const BULK_WINDOW_DAYS = Number(process.env.BULK_WINDOW_DAYS) || 45;
const API_BASE = 'https://api.jquants.com/v2';

if (!API_KEY) {
  console.error('JQUANTS_API_KEY が設定されていません');
  process.exit(1);
}

// ---------- helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let lastRequestTime = 0;
const RATE_LIMIT_MS = 13000; // 5req/分 + 安全マージン
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function pickField(obj, candidates) {
  if (!obj) return undefined;
  const keys = Object.keys(obj);
  for (const c of candidates) {
    if (obj[c] !== undefined && obj[c] !== null && obj[c] !== '') return obj[c];
  }
  const lowerCands = candidates.map(c => c.toLowerCase());
  for (const k of keys) {
    if (lowerCands.includes(k.toLowerCase()) && obj[k] !== '' && obj[k] != null) return obj[k];
  }
  for (const k of keys) {
    const lk = k.toLowerCase();
    for (const c of lowerCands) {
      if (lk.includes(c) && obj[k] !== '' && obj[k] != null) return obj[k];
    }
  }
  return undefined;
}

function findArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.data)) return json.data;
  for (const k of Object.keys(json)) {
    if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const logLines = [];
function logMsg(msg) {
  console.log(msg);
  logLines.push(msg);
}

async function apiGet(path, params) {
  let url = API_BASE + path;
  const qs = new URLSearchParams(params || {});
  let collected = [];
  let guard = 0;
  while (true) {
    guard++;
    if (guard > 25) break;
    const full = url + (qs.toString() ? ('?' + qs.toString()) : '');
    let resp;
    let retries = 0;
    while (true) {
      await rateLimitWait();
      resp = await fetch(full, { headers: { 'x-api-key': API_KEY } });
      if (resp.status === 429 && retries < 4) {
        retries++;
        await sleep(1500 * retries);
        continue;
      }
      break;
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + path + ' : ' + txt.slice(0, 200));
    }
    const json = await resp.json();
    const arr = findArray(json);
    collected = collected.concat(arr);
    const pk = json && (json.pagination_key || json.paginationKey);
    if (pk) {
      qs.set('pagination_key', pk);
    } else {
      break;
    }
  }
  return collected;
}

// ---------- date helpers ----------
function fmtDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseAnyDate(s) {
  if (!s) return null;
  const str = String(s).replace(/\//g, '-');
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
function weekdayDates(fromDate, toDate) {
  const list = [];
  const cur = new Date(fromDate);
  while (cur <= toDate) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) list.push(fmtDateOnly(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return list;
}

// ---------- earnings calendar ----------
async function fetchEarningsCandidates(daysAhead) {
  const today = new Date();
  const to = new Date(today.getTime() + daysAhead * 86400000);
  const fromStr = fmtDateOnly(today);
  const toStr = fmtDateOnly(to);

  let raw = [];
  try {
    raw = await apiGet('/equities/earnings-calendar', { from: fromStr, to: toStr });
  } catch (e) {
    logMsg('決算発表予定日(期間指定)の取得に失敗: ' + e.message + ' / パラメータなしで再試行します');
    try {
      raw = await apiGet('/equities/earnings-calendar', {});
    } catch (e2) {
      logMsg('決算発表予定日の取得に失敗しました: ' + e2.message);
      return [];
    }
  }

  const list = raw.map(r => {
    const code = pickField(r, ['Code', 'LocalCode', 'code']);
    const name = pickField(r, ['CompanyName', 'Company', 'CoName', 'name']);
    const dateVal = pickField(r, ['Date', 'AnnouncementDate', 'DisclosedDate', 'date']);
    return { code: code ? String(code) : null, name: name || '(社名不明)', announceDate: dateVal, raw: r };
  }).filter(x => x.code);

  const filtered = list.filter(x => {
    const d = parseAnyDate(x.announceDate);
    if (!d) return true;
    return d >= new Date(today.toDateString()) && d <= to;
  });

  const map = new Map();
  for (const item of (filtered.length ? filtered : list)) {
    if (!map.has(item.code)) map.set(item.code, item);
  }
  return Array.from(map.values());
}

// ---------- financial summary ----------
function normalizeFinRecord(r) {
  return {
    code: String(pickField(r, ['Code', 'LocalCode']) || ''),
    periodType: pickField(r, ['CurPerType', 'TypeOfCurrentPeriod', 'PeriodType']),
    periodEnd: pickField(r, ['CurPerEn', 'CurrentPeriodEndDate', 'PeriodEnd']),
    discDate: pickField(r, ['DiscDate', 'DisclosedDate']),
    sales: numOrNull(pickField(r, ['Sales', 'NetSales'])),
    op: numOrNull(pickField(r, ['OP', 'OperatingProfit'])),
    odp: numOrNull(pickField(r, ['OdP', 'OrdinaryProfit'])),
    np: numOrNull(pickField(r, ['NP', 'Profit', 'NetIncome'])),
    eps: numOrNull(pickField(r, ['EPS', 'EarningsPerShare'])),
    ta: numOrNull(pickField(r, ['TA', 'TotalAssets'])),
    eq: numOrNull(pickField(r, ['Eq', 'Equity', 'NetAssets'])),
    raw: r
  };
}

// 日付ベースで開示された全銘柄の財務データをまとめて取得し、コード別にプールする
async function fetchBulkFinPool(windowDays) {
  const today = new Date();
  const EMBARGO_DAYS = 90; // Freeプランは直近12週間分が取得不可
  const currentAnchor = new Date(today.getTime() - EMBARGO_DAYS * 86400000);
  const currentFrom = new Date(currentAnchor.getTime() - windowDays * 86400000);
  const currentDates = weekdayDates(currentFrom, currentAnchor);

  const priorAnchor = new Date(today.getTime() - 365 * 86400000);
  const priorFrom = new Date(priorAnchor.getTime() - windowDays * 86400000);
  const priorTo = new Date(priorAnchor.getTime() + windowDays * 86400000);
  const priorDates = weekdayDates(priorFrom, priorTo);

  const allDates = Array.from(new Set([...currentDates, ...priorDates])).sort();

  const pool = new Map();
  let done = 0;
  for (const dateStr of allDates) {
    if (done % 10 === 0) logMsg(`日付一括取得: ${done}/${allDates.length} (${dateStr})`);
    try {
      const raw = await apiGet('/fins/summary', { date: dateStr });
      for (const r of raw) {
        const rec = normalizeFinRecord(r);
        if (!rec.code || !rec.periodEnd) continue;
        if (!pool.has(rec.code)) pool.set(rec.code, []);
        pool.get(rec.code).push(rec);
      }
    } catch (e) {
      logMsg(`日付${dateStr}の一括取得に失敗: ${e.message}`);
    }
    done++;
  }
  logMsg(`日付ベース一括取得完了: ${pool.size}銘柄分のデータをプール`);
  return pool;
}

// ---------- price momentum ----------
async function fetchPriceMomentum(code) {
  const raw = await apiGet('/equities/bars/daily', { code: code });
  const bars = raw.map(r => {
    return {
      date: pickField(r, ['Date']),
      close: numOrNull(pickField(r, ['AdjC', 'C', 'Close'])),
      volume: numOrNull(pickField(r, ['Vo', 'Volume']))
    };
  }).filter(x => x.date && x.close != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (bars.length < 2) return { pct: null, days: bars.length, avgVolume: null, currentPrice: bars.length ? bars[bars.length-1].close : null };
  const first = bars[0], last = bars[bars.length - 1];
  const pct = yoy(last.close, first.close);
  const volValues = bars.map(b => b.volume).filter(v => v != null);
  const avgVolume = volValues.length ? (volValues.reduce((a, b) => a + b, 0) / volValues.length) : null;
  return { pct, days: bars.length, avgVolume, currentPrice: last.close };
}

function pickCurrentAndPrev(records) {
  const withDates = records
    .map(r => ({ ...r, endD: parseAnyDate(r.periodEnd) }))
    .filter(r => r.endD)
    .sort((a, b) => b.endD - a.endD);
  if (!withDates.length) return null;
  const current = withDates[0];
  let prev = withDates.find(r =>
    r !== current &&
    r.periodType && current.periodType &&
    r.periodType === current.periodType &&
    (current.endD - r.endD) > 300 * 86400000 &&
    (current.endD - r.endD) < 430 * 86400000
  );
  if (!prev) {
    let best = null, bestDiff = Infinity;
    const target = new Date(current.endD.getTime() - 365 * 86400000);
    for (const r of withDates) {
      if (r === current) continue;
      const diff = Math.abs(r.endD - target);
      if (diff < bestDiff && diff < 60 * 86400000) { best = r; bestDiff = diff; }
    }
    prev = best;
  }
  return { current, prev };
}

function yoy(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

// ---------- main ----------
async function main() {
  logMsg(`=== 決算ピックアップ 自動実行開始 ${new Date().toISOString()} ===`);
  logMsg(`設定: DAYS_AHEAD=${DAYS_AHEAD}, MAX_COUNT=${MAX_COUNT}, MIN_VOLUME=${MIN_VOLUME}, BULK_WINDOW_DAYS=${BULK_WINDOW_DAYS}`);

  let candidates = await fetchEarningsCandidates(DAYS_AHEAD);
  if (!candidates.length) {
    logMsg('決算発表予定の銘柄が見つかりませんでした。');
  }
  candidates = candidates.slice(0, MAX_COUNT);
  logMsg(`候補: ${candidates.length}件`);

  const bulkPool = await fetchBulkFinPool(BULK_WINDOW_DAYS);

  const results = [];
  let checkedCount = 0, noPrevCount = 0, gateFailCount = 0, volumeExcluded = 0;

  for (const c of candidates) {
    try {
      const records = bulkPool.get(String(c.code)) || [];
      const pc = pickCurrentAndPrev(records);
      checkedCount++;
      if (pc && pc.prev) {
        const salesYoy = yoy(pc.current.sales, pc.prev.sales);
        const npYoy = yoy(pc.current.np, pc.prev.np);
        const opYoy = yoy(pc.current.op, pc.prev.op);
        const odpYoy = yoy(pc.current.odp, pc.prev.odp);
        const epsYoy = yoy(pc.current.eps, pc.prev.eps);
        const salesUp = salesYoy != null && salesYoy > 0;
        const profitYoy = npYoy != null ? npYoy : opYoy;
        const profitUp = profitYoy != null && profitYoy > 0;

        let marginChange = null;
        if (pc.current.np != null && pc.current.sales && pc.prev.np != null && pc.prev.sales) {
          const curMargin = pc.current.np / pc.current.sales * 100;
          const prevMargin = pc.prev.np / pc.prev.sales * 100;
          marginChange = curMargin - prevMargin;
        }

        const epsUp = epsYoy == null || epsYoy >= 0;
        const allClear = salesUp && profitUp && epsUp;

        if (!allClear) {
          gateFailCount++;
        } else {
          let momentum = null, momentumDays = 0, avgVolume = null, currentPrice = null;
          try {
            const pm = await fetchPriceMomentum(c.code);
            momentum = pm.pct;
            momentumDays = pm.days;
            avgVolume = pm.avgVolume;
            currentPrice = pm.currentPrice;
          } catch (e) {
            logMsg(`${c.code} ${c.name || ''}: 株価データ取得失敗 (${e.message})`);
          }
          if (avgVolume != null && avgVolume < MIN_VOLUME) {
            logMsg(`${c.code} ${c.name || ''}: 平均出来高${Math.round(avgVolume)}株が基準(${MIN_VOLUME}株)未満のため除外`);
            volumeExcluded++;
          } else {
            const totalScore = salesYoy + profitYoy + (momentum || 0)
              + (odpYoy || 0) * 0.5 + (epsYoy || 0) * 0.5
              + (marginChange || 0) * 2;
            results.push({
              code: c.code, name: c.name, announceDate: c.announceDate,
              periodLabel: (pc.current.periodEnd || '') + ' (' + (pc.current.periodType || '?') + ')',
              sales: { cur: pc.current.sales, prev: pc.prev.sales, yoy: salesYoy },
              profit: { cur: pc.current.np != null ? pc.current.np : pc.current.op, prev: pc.prev.np != null ? pc.prev.np : pc.prev.op, yoy: profitYoy, label: pc.current.np != null ? '純利益' : '営業利益' },
              odpYoy, epsYoy, marginChange,
              momentum: { pct: momentum, days: momentumDays },
              avgVolume, currentPrice,
              totalScore
            });
          }
        }
      } else {
        noPrevCount++;
      }
    } catch (e) {
      logMsg(`${c.code} ${c.name || ''}: 取得失敗 (${e.message})`);
    }
  }

  logMsg(`内訳: チェック${checkedCount}件 / 前年データなし${noPrevCount}件 / 売上・利益・EPSのいずれかマイナス${gateFailCount}件 / 出来高不足で除外${volumeExcluded}件 / 結果${results.length}件`);

  const top10 = results.slice().sort((a, b) => (b.totalScore || -9999) - (a.totalScore || -9999)).slice(0, 10);

  const output = {
    generatedAt: new Date().toISOString(),
    config: { daysAhead: DAYS_AHEAD, maxCount: MAX_COUNT, minVolume: MIN_VOLUME, bulkWindowDays: BULK_WINDOW_DAYS },
    checkedCount, noPrevCount, gateFailCount, volumeExcluded,
    matchedCount: results.length,
    results: top10
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'results.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(dataDir, 'run-log.txt'), logLines.join('\n'));

  // GitHub Issue本文用のサマリー
  const fmtYoyStr = (n) => n == null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  let body = `## 決算ピックアップ 自動取得結果\n\n`;
  body += `実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n\n`;
  body += `チェック対象 ${checkedCount}件 / 条件クリア ${results.length}件中 TOP${top10.length}\n\n`;
  if (top10.length) {
    body += `| # | 銘柄 | コード | 株価 | 売上高YoY | 利益YoY | EPS YoY | 株価騰落率 | 成績合計 |\n`;
    body += `|---|---|---|---|---|---|---|---|---|\n`;
    top10.forEach((r, i) => {
      const priceStr = r.currentPrice != null ? r.currentPrice.toLocaleString() + '円' : '—';
      body += `| ${i + 1} | ${r.name || ''} | ${r.code} | ${priceStr} | ${fmtYoyStr(r.sales.yoy)} | ${fmtYoyStr(r.profit.yoy)} | ${fmtYoyStr(r.epsYoy)} | ${fmtYoyStr(r.momentum.pct)} | ${fmtYoyStr(r.totalScore)} |\n`;
    });
  } else {
    body += `条件を満たす銘柄はありませんでした。\n`;
  }
  body += `\n詳細はアプリ側の「自動取得結果を見る」から確認できます。\n`;
  body += `\n---\n本アプリは投資助言を行うものではありません。`;

  fs.writeFileSync(path.join(dataDir, 'issue-body.txt'), body);

  logMsg('=== 完了 ===');
}

main().catch(e => {
  console.error(e);
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'issue-body.txt'), `## 決算ピックアップ 自動取得エラー\n\n${e.message}\n\n\`\`\`\n${e.stack}\n\`\`\``);
  fs.writeFileSync(path.join(dataDir, 'run-log.txt'), logLines.join('\n') + '\n\nERROR: ' + e.message);
  process.exit(1);
});
