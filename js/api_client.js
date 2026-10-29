// js/api_client.js
// 把遊戲結算統計送到後端 API 寫進 SQL Server。
// API URL 在 index.html 用 window.GAME_API_BASE 設定,部署時改那邊即可。

const API_BASE = () => (window.GAME_API_BASE || '').replace(/\/$/, '');

// 上傳不成功的結算先暫存在本機,下次開啟遊戲時自動補傳
const PENDING_KEY = 'pending_game_stats';
const MAX_PENDING = 20;
let isFlushing = false;

/**
 * @param {object} payload
 * @param {string} payload.playerName
 * @param {'tongue'|'mouth'|'voice'} payload.mode
 * @param {'tutorial'|'easy'|'medium'|'hard'} payload.difficulty
 * @param {Object<string,{success:number, fail:number}>} payload.stats
 * @param {string} [payload.playedAt] 遊玩時間(ISO);補傳時沿用原本的時間
 */
export async function sendGameStats(payload) {
  if (!API_BASE()) {
    console.warn('[api_client] window.GAME_API_BASE 未設定,跳過上傳');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${API_BASE()}/api/game-stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playedAt: new Date().toISOString(), ...payload }),
    });
    if (!res.ok) {
      console.warn('[api_client] 上傳失敗 HTTP', res.status, await res.text().catch(()=>''));
      return { ok: false, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    console.log('[api_client] 上傳成功', body);
    return { ok: true, ...body };
  } catch (e) {
    console.warn('[api_client] 上傳例外:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 失敗是否值得重試:4xx(資料本身有問題)重送也不會成功,408/429 例外 */
export function isRetryable(res) {
  if (res.ok || res.skipped) return false;
  const s = res.status;
  return !(s >= 400 && s < 500) || s === 408 || s === 429;
}

function readPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { return []; }
}

function writePending(list) {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* 無痕模式等存不了就放棄 */ }
}

/** 把上傳失敗的結算存到本機 */
export function queuePendingStats(payload) {
  const list = readPending();
  list.push(payload);
  writePending(list);
}

/** 補傳本機暫存的結算;回傳成功筆數 */
export async function flushPendingStats() {
  if (isFlushing) return 0;
  const list = readPending();
  if (!list.length) return 0;
  isFlushing = true;

  const remaining = [];
  let sent = 0;
  for (const p of list) {
    const res = await sendGameStats(p);
    if (res.ok) sent++;
    else if (isRetryable(res)) remaining.push(p);
  }

  // 補傳期間若又有新的失敗紀錄存進來,一併保留
  const processed = new Set(list.map(p => JSON.stringify(p)));
  const added = readPending().filter(p => !processed.has(JSON.stringify(p)));
  writePending([...remaining, ...added]);

  isFlushing = false;
  return sent;
}

/** 健康檢查:也用來提前喚醒冷啟動中的 Azure App Service 與 SQL */
export async function pingApi() {
  if (!API_BASE()) return false;
  try {
    const res = await fetch(`${API_BASE()}/api/health`, { method: 'GET' });
    return res.ok;
  } catch { return false; }
}
