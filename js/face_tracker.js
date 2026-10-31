// js/face_tracker.js
// 全遊戲共用的臉部偵測迴圈:每一張新的鏡頭畫面只跑一次 MediaPipe,
// 再把結果廣播給嘴型 / 舌頭 / 發聲模組,取代各模式各自呼叫 detectForVideo。

const listeners = new Set();
let landmarker = null;
let video = null;
let running = false;
let lastVideoTime = -1;

// 註冊「每張新畫面」的回呼:cb(results, now)
export function onFaceFrame(cb) {
    listeners.add(cb);
}

export function startFaceTracking(faceLandmarker, videoElement) {
    landmarker = faceLandmarker;
    video = videoElement;
    if (running) return;
    running = true;
    requestAnimationFrame(loop);
}

function loop() {
    requestAnimationFrame(loop);
    if (!landmarker || !video || video.readyState < 2) return;

    // 螢幕更新率通常比鏡頭幀率高,同一張畫面不重複偵測
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const now = performance.now();
    let results;
    try {
        results = landmarker.detectForVideo(video, now);
    } catch (e) {
        console.warn('[face_tracker] 臉部偵測失敗:', e);
        return;
    }
    // 單一模組出錯不影響其他模組,也不會讓迴圈停掉
    listeners.forEach(cb => {
        try { cb(results, now); } catch (e) { console.error('[face_tracker] 模組處理錯誤:', e); }
    });
}
