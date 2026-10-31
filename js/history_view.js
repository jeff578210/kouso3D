// js/history_view.js
// 歷史紀錄檢視:抓 API → 統計 → Chart.js 繪圖

const MODE_LABELS = { tongue: '舌頭', mouth: '嘴型', voice: '發聲' };
const MODE_COLORS = { tongue: '#e67e22', mouth: '#3498db', voice: '#9b59b6' };
const DIFF_LABELS = { tutorial: '教學', easy: '初級', medium: '中級', hard: '高級' };

let chartTrend = null;
let chartMode = null;

const $ = (id) => document.getElementById(id);

// Chart.js 只有打開訓練紀錄才用得到,第一次打開時才下載(不拖慢遊戲載入)
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
let chartJsPromise = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (!chartJsPromise) {
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_JS_URL;
      s.onload = resolve;
      s.onerror = () => { chartJsPromise = null; reject(new Error('圖表元件載入失敗,請檢查網路')); };
      document.head.appendChild(s);
    });
  }
  return chartJsPromise;
}

async function fetchHistory(playerName) {
  const base = (window.GAME_API_BASE || '').replace(/\/$/, '');
  if (!base) throw new Error('window.GAME_API_BASE 未設定');
  const url = `${base}/api/game-stats?player=${encodeURIComponent(playerName)}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'API 回錯');
  return body.rows || [];
}

function formatTime(iso) {
  const d = new Date(iso);
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${M}/${D} ${h}:${m}`;
}

function renderStats(rows) {
  const total = rows.length;
  const rates = rows.map(r => Number(r.AchievementRate) || 0);
  const avg = rates.reduce((a, b) => a + b, 0) / (total || 1);
  const best = rates.reduce((a, b) => Math.max(a, b), 0);
  const recent = rows[0]?.CreatedAt ? formatTime(rows[0].CreatedAt) : '-';
  $('stat-total').textContent = total;
  $('stat-avg').textContent = avg.toFixed(1) + '%';
  $('stat-best').textContent = best.toFixed(1) + '%';
  $('stat-recent').textContent = recent;
}

function renderTrendChart(rows) {
  // 取最近 20 場(rows 已經是 CreatedAt DESC,反轉讓左邊是舊、右邊是新)
  const recent = rows.slice(0, 20).reverse();
  const labels = recent.map((r, i) => `${i + 1}`);
  const data = recent.map(r => Number(r.AchievementRate) || 0);
  const modeColors = recent.map(r => MODE_COLORS[r.Mode] || '#95a5a6');

  if (chartTrend) chartTrend.destroy();
  chartTrend = new Chart($('chart-trend'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '達成率 (%)',
        data,
        borderColor: '#27ae60',
        backgroundColor: 'rgba(39, 174, 96, 0.15)',
        pointBackgroundColor: modeColors,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 5,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
        x: { title: { display: true, text: '場次順序(左舊 → 右新)' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const r = recent[i];
              return `${formatTime(r.CreatedAt)} · ${MODE_LABELS[r.Mode] || r.Mode}`;
            },
            label: (item) => `達成率 ${item.parsed.y.toFixed(1)}%`,
          },
        },
      },
    },
  });
}

function renderModeChart(rows) {
  const counts = { tongue: 0, mouth: 0, voice: 0 };
  rows.forEach(r => { if (counts[r.Mode] != null) counts[r.Mode]++; });

  if (chartMode) chartMode.destroy();
  chartMode = new Chart($('chart-mode'), {
    type: 'doughnut',
    data: {
      labels: ['舌頭', '嘴型', '發聲'],
      datasets: [{
        data: [counts.tongue, counts.mouth, counts.voice],
        backgroundColor: [MODE_COLORS.tongue, MODE_COLORS.mouth, MODE_COLORS.voice],
        borderColor: '#fff', borderWidth: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12 } },
        tooltip: {
          callbacks: { label: (item) => `${item.label}:${item.parsed} 場` },
        },
      },
    },
  });
}

function renderTable(rows) {
  const tbody = $('history-tbody');
  tbody.innerHTML = '';
  rows.slice(0, 10).forEach((r) => {
    const rate = Number(r.AchievementRate) || 0;
    const rateColor = rate >= 80 ? '#27ae60' : rate >= 50 ? '#f39c12' : '#e74c3c';
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #ecf0f1';
    tr.innerHTML = `
      <td style="padding:8px;">${formatTime(r.CreatedAt)}</td>
      <td style="padding:8px; text-align:center;">
        <span style="background:${MODE_COLORS[r.Mode] || '#95a5a6'}; color:#fff; padding:2px 8px; border-radius:10px; font-size:12px;">
          ${MODE_LABELS[r.Mode] || r.Mode}
        </span>
      </td>
      <td style="padding:8px; text-align:center;">${DIFF_LABELS[r.Difficulty] || r.Difficulty}</td>
      <td style="padding:8px; text-align:center;">
        <span style="color:#27ae60;">${r.TotalSuccess}</span> /
        <span style="color:#e74c3c;">${r.TotalFail}</span>
      </td>
      <td style="padding:8px; text-align:right; font-weight:700; color:${rateColor};">${rate.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

export async function openHistory(playerName) {
  const overlay = $('history-overlay');
  const nameEl = $('history-name');
  const loading = $('history-loading');
  const emptyEl = $('history-empty');
  const content = $('history-content');

  nameEl.textContent = playerName || 'Guest';
  overlay.style.display = 'flex';
  loading.style.display = 'block';
  emptyEl.style.display = 'none';
  content.style.display = 'none';

  try {
    const [rows] = await Promise.all([fetchHistory(playerName), loadChartJs()]);
    loading.style.display = 'none';
    if (!rows.length) {
      emptyEl.style.display = 'block';
      return;
    }
    content.style.display = 'block';
    renderStats(rows);
    renderTrendChart(rows);
    renderModeChart(rows);
    renderTable(rows);
  } catch (e) {
    loading.innerHTML = `<span style="color:#e74c3c;">❌ 載入失敗:${e.message}</span>`;
    console.error('[history] fetch error:', e);
  }
}

export function closeHistory() {
  $('history-overlay').style.display = 'none';
}

// 綁定關閉按鈕 + 點背景關閉
window.addEventListener('DOMContentLoaded', () => {
  const overlay = $('history-overlay');
  $('history-close')?.addEventListener('click', closeHistory);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeHistory();
  });
});
