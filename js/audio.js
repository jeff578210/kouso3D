// js/audio.js
// 遊戲音訊集中管理:共用 AudioContext、按需開關的麥克風、背景噪音追蹤、過關音效。
//
// 麥克風刻意「不」開回音消除 / 降噪 / 自動增益:這些通話處理會讓裝置切進通話模式,
// 系統會把背景音樂與音效壓小、聽起來斷斷續續(所有瀏覽器都會)。遊戲只需要量音量,
// 用不到通話品質;被麥克風收進來的背景音樂改由 noiseFloor 自動扣除。

let ctx = null;
let dataArray = null;
let analyser = null;

let micStream = null;
let micSource = null;
let micGeneration = 0;   // 每次 closeMic +1,讓「開到一半就被關掉」的請求作廢
let micOpenedAt = 0;
let lastReadAt = 0;

// 背景噪音估計值(含被收進來的背景音樂、音效、環境音)。過關門檻 = 難度門檻 + noiseFloor
export let noiseFloor = 0;

export function getAudioContext() {
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256; // 與原本相同,讓各難度的音量門檻維持同一個量尺
        dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    return ctx;
}

// 必須在玩家點擊的當下呼叫(iOS / Chrome 的自動播放限制)
export function resumeAudio() {
    const c = getAudioContext();
    if (c.state === 'suspended') c.resume().catch(() => {});
}

export function isMicOpen() {
    return !!micStream;
}

// 開麥克風(已開就直接回傳 true);拒絕權限或沒有裝置時回傳 false
export async function openMic() {
    if (micStream) return true;
    const myGeneration = micGeneration;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
    } catch (err) {
        console.warn('🎙️ 無法開啟麥克風:', err);
        return false;
    }
    // 等權限的期間遊戲已經結束,或另一個請求已經開好了:這次的串流直接關掉
    if (myGeneration !== micGeneration || micStream) {
        stream.getTracks().forEach(t => t.stop());
        return !!micStream;
    }
    micStream = stream;
    micSource = getAudioContext().createMediaStreamSource(stream);
    micSource.connect(analyser); // 只接分析器,不接喇叭,不會回授
    micOpenedAt = lastReadAt = performance.now();
    noiseFloor = 0;
    console.log('🎙️ 麥克風已開啟(音量模式)');
    return true;
}

export function closeMic() {
    micGeneration++;
    if (micSource) { micSource.disconnect(); micSource = null; }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
        console.log('🎙️ 麥克風已關閉');
    }
    noiseFloor = 0;
}

// 讀目前音量(0~255 頻譜平均,與原本的量法相同),同時更新背景噪音估計。
// 同一幀被呼叫多次也沒關係:噪音追蹤是依實際經過時間計算的。
export function readVolume() {
    if (!micStream) return 0;
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const volume = sum / dataArray.length;

    const now = performance.now();
    const dt = now - lastReadAt;
    lastReadAt = now;
    // 剛開麥克風的頭 1 秒是校正期:估計值直接等於目前音量(這段時間不會判定為出聲),
    // 避免一開局就把背景音樂當成玩家的聲音
    if (now - micOpenedAt < 1000) {
        noiseFloor = volume;
        return volume;
    }
    // 之後:比估計值小 → 很快往下貼近(安靜下來時門檻馬上恢復);
    //       比估計值大 → 慢慢往上爬,持續的背景音樂會被吸收,玩家短暫的喊聲則不會
    const tau = volume < noiseFloor ? 300 : 10000;
    noiseFloor += (volume - noiseFloor) * Math.min(1, dt / tau);
    return volume;
}

// 音量條上的紅線:顯示實際的過關門檻(難度門檻 + 背景噪音)
export function updateThresholdLine(baseThreshold) {
    const line = document.getElementById("meter-threshold");
    if (line) line.style.left = `${Math.min(((baseThreshold + noiseFloor) / 80) * 100, 100)}%`;
}

// 過關音效:Web Audio 即時合成的上升三和弦(不需要額外音檔)
export function playSuccessSound() {
    const c = getAudioContext();
    if (c.state !== 'running') return;
    const start = c.currentTime;
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    [523.25, 659.25, 783.99].forEach((freq, i) => { // Do Mi Sol
        const t = start + i * 0.09;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.35, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        osc.connect(gain).connect(master);
        osc.start(t);
        osc.stop(t + 0.5);
    });
}
