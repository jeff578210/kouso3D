// js/debug_panel.js
// 網址加上 ?debug=1 時,在畫面左上角即時顯示判定用的數值(例如 https://…/kouso3D/?debug=1),
// 實際玩的時候可以看出是哪一項沒達到門檻,方便調整。沒加參數時完全不做事。

export const DEBUG = new URLSearchParams(location.search).has('debug');

const sections = {};
let panel = null;
let lastDraw = 0;

// 除錯模式下在畫面左下角加一個按鈕,回傳按鈕元素(可以改文字);沒開除錯模式時回傳 null
let toolbar = null;
export function debugButton(label, onClick) {
    if (!DEBUG) return null;
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.style.cssText = 'position: fixed; left: 8px; bottom: 8px; z-index: 10001; display: flex; gap: 6px;';
        document.body.appendChild(toolbar);
    }
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'padding: 8px 12px; font-size: 14px; border-radius: 8px; background: rgba(0,0,0,0.75);';
    btn.addEventListener('click', onClick);
    toolbar.appendChild(btn);
    return btn;
}

// section:區塊名稱;rows:{ 標題: 值 },數字自動取到小數第二位
export function debugShow(section, rows) {
    if (!DEBUG) return;
    sections[section] = rows;
    const now = performance.now();
    if (now - lastDraw < 100) return; // 每秒更新 10 次就夠看了
    lastDraw = now;

    if (!panel) {
        panel = document.createElement('pre');
        panel.style.cssText = `
            position: fixed; left: 8px; top: 8px; z-index: 10001; margin: 0;
            background: rgba(0,0,0,0.72); color: #fff; padding: 8px 10px; border-radius: 8px;
            font: 12px/1.45 Consolas, monospace; white-space: pre; pointer-events: none;`;
        document.body.appendChild(panel);
    }
    panel.textContent = Object.entries(sections).map(([name, data]) =>
        `【${name}】\n` + Object.entries(data)
            .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`)
            .join('\n')
    ).join('\n\n');
}
