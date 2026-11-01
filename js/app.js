// ==========================================
// 核心模組載入
// ==========================================
import { createWorld } from './world3d.js';
// MediaPipe 改在 initMediaPipe() 裡動態載入,CDN 失敗時才能顯示錯誤畫面

import { startMouthDetection, stopMouthDetection, setMicStatus } from './mode_mouth.js';
import { startVoiceDetection,stopVoiceDetection ,voiceConfig,stopTfjsDetection,initTfjsVoice,startTfjsDetection} from './mode_voice.js';
import { initTongueMode,startTongueDetection} from './mode_tongue.js';
import { sendGameStats, isRetryable, queuePendingStats, flushPendingStats, pingApi } from './api_client.js';
import { openHistory } from './history_view.js';
import { startFaceTracking } from './face_tracker.js';
import { resumeAudio, openMic, closeMic, playSuccessSound, updateThresholdLine } from './audio.js';

// ==========================================
// 全域變數匯出
// ==========================================
export let currentVrm = null;
export let isGameRunning = false;
export let currentDifficulty = "hard";
export let currentTrainingMode = "mouth";
export let poseQueue = [];
export let isTutorialLocked = false;
export let accumulatedHoldTime = 0;
export let videoElement;//全域的攝影機
export let globalStream;//攝影機影像來源(麥克風改由 audio.js 在需要時才開)
export let faceLandmarker;//MediaPipe元件
export let world = null; //左邊的 3D 世界(world3d.js),題目泡泡/巨石與過關特效都由它顯示

//各等級辨識參數
export const DIFFICULTY_CONFIG = {
    tutorial: { requireAudio: true, volThreshold: 15, holdDuration: 1500, accumulateProgress: true, isTutorial: true, jaw_A: 0.25, pucker_U: 0.4, funnel_O: 0.25, stretch_I: 0.3, stretch_E: 0.15 },
    easy: { requireAudio: false, volThreshold: 0, holdDuration: 2000, accumulateProgress: true, isTutorial: false, jaw_A: 0.25, pucker_U: 0.4, funnel_O: 0.25, stretch_I: 0.3, stretch_E: 0.15 },
    medium: { requireAudio: true, volThreshold: 15, holdDuration: 2000, accumulateProgress: false, isTutorial: false, jaw_A: 0.35, pucker_U: 0.55, funnel_O: 0.35, stretch_I: 0.4, stretch_E: 0.25 },
    hard: { requireAudio: true, volThreshold: 25, holdDuration: 2000, accumulateProgress: false, isTutorial: false, jaw_A: 0.45, pucker_U: 0.7, funnel_O: 0.4, stretch_I: 0.5, stretch_E: 0.35 }
};

export let gameStats = {};
export let playerName = '';   // 由開頭的玩家名稱輸入框設定;會跟結算統計一起送到 API

// 音效設定
// 🔥 偵測是否為行動裝置(手機喇叭離麥克風近,BGM 稍微小聲一點)
const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
                  || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform)); // iPad iOS 13+
const bgm = new Audio('./bgm.mp3');
bgm.loop = true;
bgm.preload = 'auto';
// 被麥克風收進去的音樂已由 audio.js 的背景噪音追蹤扣除,不必再把手機音量壓得很低
bgm.volume = IS_MOBILE ? 0.6 : 0.8;

// ==========================================
// 1. 初始化系統與 3D 渲染
// ==========================================
async function startSystem() {
    // 3D 場景和臉部辨識/鏡頭/舌頭模型同時載入
    await Promise.all([
        initWorld(),
        (async () => {
            await initMediaPipe();
            await initCamera();
            await initTongueMode();
        })(),
    ]);

    // 全遊戲共用一條臉部偵測迴圈,各模式只接收結果
    startFaceTracking(faceLandmarker, videoElement);

    // 系統載入完成後，立刻啟動背景頭部/嘴部追蹤，永遠不關閉
    startMouthDetection();
    startTongueDetection();

    //隱藏請稍候提示,顯示開始遊戲按鈕
    unlockGameUI();
}

async function initMediaPipe(){
    console.log("正在載入 MediaPipe 臉部追蹤與語音辨識模組...");
    //載入MediaPipe
        const { FaceLandmarker, FilesetResolver } = await import("https://cdn.skypack.dev/@mediapipe/tasks-vision@0.10.3");
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                delegate: "GPU"
            },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true, 
            runningMode: "VIDEO",
            numFaces: 1
        });
}

export async function initCamera() {
    console.log("📷 正在啟動全域攝影機與麥克風...");

    // 1. 建立或取得唯一的 video 標籤
    videoElement = document.getElementById("video");
    if (!videoElement) {
        videoElement = document.createElement('video');
        videoElement.id = 'video';
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true; // 🔥 防止 video 元素自己播出聲音造成第二層回音
        videoElement.style.display = 'none';
        document.body.appendChild(videoElement);
    }
    // 確保 video 元素本身不發聲(行動裝置易被忽略)
    videoElement.muted = true;
    videoElement.volume = 0;

    // 2. 一次問完攝影機與麥克風權限。麥克風拿到授權後立刻關掉:
    //    一直開著(尤其是開回音消除)會讓裝置切進通話模式,背景音樂和音效會被系統壓小、斷斷續續。
    //    之後只在需要聽聲音的遊戲,由 audio.js 的 openMic() 重新打開。
    try {
        const constraints = {
            video: {
                facingMode: 'user',
                width:  { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        };
        globalStream = await navigator.mediaDevices.getUserMedia(constraints);
        globalStream.getAudioTracks().forEach(track => {
            track.stop();
            globalStream.removeTrack(track);
        });

        videoElement.srcObject = globalStream;

        // 🌟 關鍵：必須等 video 準備好，才算真的載入完成
        return new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play().catch(()=>{});
                console.log("✅ 全域攝影機啟動完成(麥克風已授權,需要時才開啟)");
                resolve();
            };
        });
    } catch (err) {
        console.error("❌ 無法取得攝影機或麥克風權限", err);
        throw err; // 把錯誤往上丟，阻止後續載入，由 showInitError 顯示原因
    }
}

function unlockGameUI(){
    document.getElementById("loading-overlay").style.display = "none";
    world.playIntro(); // 載入畫面拿掉後,鏡頭從山谷上空飛到人物面前
    const btns = ["btn-tutorial", "btn-easy", "btn-medium", "btn-hard"];
    btns.forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.disabled = false;
    });
    // 綁定歷史紀錄按鈕
    const histBtn = document.getElementById("btn-history");
    if (histBtn) {
        histBtn.disabled = false;
        histBtn.addEventListener("click", () => {
            const name = playerName || localStorage.getItem('player_name') || 'Guest';
            openHistory(name);
        });
    }
}

// 3D 畫質:手機與核心數/記憶體較少的電腦用低畫質(網址加 ?q=high 或 ?q=low 可強制指定)
function pickQuality() {
    const forced = new URLSearchParams(location.search).get('q');
    if (forced === 'high' || forced === 'low') return forced;
    const weak = IS_MOBILE || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
    return weak ? 'low' : 'high';
}

// 左邊的 3D 世界:場景、人物、鏡頭、尺寸變化都由 world3d.js 處理
async function initWorld() {
    world = await createWorld(document.getElementById("canvas-container"), {
        quality: pickQuality(),
        onVrmLoaded: vrm => { currentVrm = vrm; },
    });
}

// ==========================================
// 2. 模式切換邏輯
// ==========================================
document.getElementById("mode-mouth")?.addEventListener('click', () => switchTrainingMode('mouth'));
document.getElementById("mode-voice")?.addEventListener('click', () => switchTrainingMode('voice'));
document.getElementById("mode-tongue")?.addEventListener('click', () => switchTrainingMode('tongue'));

function switchTrainingMode(mode) {
    if (isGameRunning || isStartingGame) return; //遊戲進行中(或正在等麥克風權限)不能更換模式
    stopAllEngines(); //請除所有的語音偵測辨識冷卻狀態
    currentTrainingMode = mode;
    console.log(`切換至訓練模式：${mode}`);
    // UI 按鈕切換
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`mode-${mode}`)?.classList.add('active');
    initQueue(); //根據新的 currentTrainingMode，重新去各自的模組（如嘴型題庫、發聲題庫）抓取對應的關卡資料，重新填滿陣列
}

// ==========================================
// 3. 遊戲流程控制 (開始、結束、過關判定)
// ==========================================

// 安全綁定點擊事件
document.getElementById("btn-tutorial")?.addEventListener('click', () => startGame("tutorial"));
document.getElementById("btn-easy")?.addEventListener('click', () => startGame("easy"));
document.getElementById("btn-medium")?.addEventListener('click', () => startGame("medium"));
document.getElementById("btn-hard")?.addEventListener('click', () => startGame("hard"));
document.getElementById("endBtn")?.addEventListener('click', endGame);

// 🎙️ 修復：語音判定開關按鈕 (點擊時同步隱藏/顯示音量條)
document.getElementById("toggleMicBtn")?.addEventListener('click', (e) => {
    const btn = e.target;
    const isOn = btn.innerText.includes('開啟');
    const meterContainer = document.getElementById("audio-meter-container");

    if (isOn) {
        btn.innerText = '🎙️ 語音判定：關閉';
        btn.classList.add('off');
        setMicStatus(false);
        closeMic(); // 不用聽聲音就關掉麥克風,音樂與音效恢復正常音量
        // 👇 改用 visibility 隱藏，保留空間
        if (meterContainer) meterContainer.style.visibility = "hidden";
    } else {
        btn.innerText = '🎙️ 語音判定：開啟';
        btn.classList.remove('off');
        openMic().then(ok => {
            if (!isGameRunning) return;
            setMicStatus(ok); // 打不開(沒權限/沒裝置)就維持關閉,不會卡在「聲音不夠大」
            // 👇 改用 visibility 顯示
            if (ok && meterContainer) meterContainer.style.visibility = "visible";
        });
    }
});

// 強制暴露給全域
window.startGame = startGame;
window.endGame = endGame;

// 📖 修復：定義新手教學的專屬順序 (ㄚ、ㄧ、ㄨ 循環 3 次，共 9 題)
let tutorialIndex = 0;
let turnToken = 0; // 每出一題 +1,用來辨識語音解鎖事件是不是屬於目前這一題
let isStartingGame = false; // 開局時正在等麥克風開啟,避免重複點擊開兩局
let gameRound = 0; // 每開一局 +1,讓上一局還沒跑完的延遲動作(換下一題)作廢
const TUTORIAL_SEQUENCE = ["ㄚ", "ㄧ", "ㄨ", "ㄚ", "ㄧ", "ㄨ", "ㄚ", "ㄧ", "ㄨ"];

async function startGame(mode) {
    if (isGameRunning || isStartingGame) return;
    // 確保音訊環境啟動、音樂開播(必須在點擊當下、任何 await 之前,否則手機會擋自動播放)
    resumeAudio();
    bgm.play().catch(e => {});

    // 只有需要聽聲音的遊戲才開麥克風:發聲模式一定要;嘴型模式看難度與「語音判定」開關;舌頭模式不開
    const micBtn = document.getElementById("toggleMicBtn");
    const isMicOff = micBtn && micBtn.classList.contains('off');
    const needsMic = currentTrainingMode === 'voice'
        || (currentTrainingMode === 'mouth' && DIFFICULTY_CONFIG[mode].requireAudio && !isMicOff);
    let micReady = false;
    if (needsMic) {
        isStartingGame = true;
        micReady = await openMic();
        isStartingGame = false;
        if (!micReady && currentTrainingMode === 'voice') {
            bgm.pause();
            const statusDisplay = document.getElementById("status-message");
            if (statusDisplay) statusDisplay.innerText = "發聲訓練需要麥克風,請允許麥克風權限後再試一次！";
            return;
        }
    }

    currentDifficulty = mode;
    isGameRunning = true;
    gameRound++;
    isTutorialLocked = (mode === "tutorial");
    tutorialIndex = 0;

    pingApi(); // 遊戲進行中先喚醒 Azure 後端,結算時就不會撞上冷啟動

    const isEasyMode = (mode === "easy");
    const isTongueMode = (currentTrainingMode === 'tongue'); 

    // 🌟 修復 1：動態重置統計資料 (根據不同模式準備不同的計分板)
    gameStats = {};
    let statKeys = [];
    if (currentTrainingMode === 'mouth') statKeys = ["ㄚ", "ㄧ", "ㄨ", "ㄟ", "ㄛ"];
    else if (currentTrainingMode === 'tongue') statKeys = ['⬆️', '⬇️', '⬅️', '➡️'];
    else if (currentTrainingMode === 'voice') statKeys = ["PA", "TA", "KA", "LA"];
    
    statKeys.forEach(k => { gameStats[k] = { success: 0, fail: 0 }; });

    // 切換 UI 顯示狀態
    changeUIshow();
    world.setMode(currentTrainingMode); // 左邊 3D:嘴型/舌頭出現目標圈與泡泡,發聲出現巨石
    const meterContainer = document.getElementById("audio-meter-container");

    // 🌟 UI 與麥克風強制連動邏輯
    if (currentTrainingMode === 'voice') {
            // 🗣️ 發聲模式：隱藏按鈕，顯示音量條，並【強制開啟麥克風】
            if (micBtn) { micBtn.style.display = "none"; }
            setMicStatus(true); 
            startVoiceDetection();
    } 
    else if (isTongueMode) {
        // 👅 舌頭模式：不需要聲音，全部隱藏
        if (micBtn) { micBtn.style.display = "none"; }
        if (meterContainer) { meterContainer.style.display = "none"; }
    } 
    else {
        // 👄 嘴型模式：依據難度顯示
        if (micBtn) {
            micBtn.style.display = "block";
            micBtn.style.display = isEasyMode ? "none" : "block";
        }
        if (meterContainer) {
            meterContainer.style.display = "flex";
            meterContainer.style.visibility = (isEasyMode || !micReady) ? "hidden" : "visible";
        }
        // 初級本來就不判定聲音,不動開關狀態;其他難度依麥克風實際有沒有打開
        if (!isEasyMode) setMicStatus(micReady);
    }

    // 音量條紅線 = 實際過關門檻(遊戲中會隨背景噪音即時更新)
    updateThresholdLine(currentTrainingMode === 'voice' ? getVolumeLevel() : DIFFICULTY_CONFIG[mode].volThreshold);

    initQueue();  //載入題目
    renderBelt(); //渲染畫面
    startTurnTimer();
}

export function getVolumeLevel(){
    let num ;
    if(currentDifficulty === "hard"){
        num = 40;
    }else if(currentDifficulty === "medium"){
        num = 30;
    }else{
        num = 20;
    }

    return num;
}

function endGame() {
    isGameRunning = false;
    isTutorialLocked = false; 
    bgm.pause();
    window.speechSynthesis.cancel();
    stopAllEngines();
    closeMic(); // 回到首頁就關麥克風
    world?.setMode(null); // 收起 3D 的題目泡泡/巨石

    // 恢復 UI 顯示狀態
    const els = {
        "tutorial-controls": "flex",
        "start-controls": "flex",
        "history-controls": "flex",
        "game-controls": "none",
        "audio-meter-container": "none" ,
        "mode-mouth":"flex", //嘴型訓練按鈕
        "mode-voice":"flex", //發聲訓練按鈕
        "mode-tongue":"flex", //舌頭訓練按鈕
        "hint-message":"none", //遊戲內提示文字
         "game-title":"flex" //遊戲標題
    };
    for (let id in els) {
        let el = document.getElementById(id);
        if (el) el.style.display = els[id];
    }
    
    // 🌟 修復 4：動態生成符合當前模式的結算報表
    const statusDisplay = document.getElementById("status-message");
    if (statusDisplay) {
        if (currentDifficulty !== "tutorial") {
            // 一題都還沒完成就結束:不顯示結算、不上傳,避免 0/0 的紀錄拉低平均達成率
            let attempts = 0;
            for (let key in gameStats) attempts += gameStats[key].success + gameStats[key].fail;
            if (attempts === 0) {
                statusDisplay.innerText = "這場還沒完成任何題目,不列入訓練紀錄。";
                return;
            }

            statusDisplay.innerText = "挑戰結束！查看結算：";
            const statsPanel = document.getElementById("stats-panel");
            if (statsPanel) {
                statsPanel.style.display = "block";
                let html = '<h3 style="color: #333; text-align: center;">📊 動作達成率統計</h3><ul style="color: #333; font-size: 18px; padding-left: 20px;">';

                for (let key in gameStats) {
                    let total = gameStats[key].success + gameStats[key].fail;
                    if (total === 0) continue; // 這場沒出現過的題目不列出
                    let rate = Math.round((gameStats[key].success / total) * 100);
                    if (currentTrainingMode === 'voice') {
                        // 發聲模式專屬文字
                        html += `<li style="margin-bottom: 10px;"><strong>${key}</strong>: 成功擊碎 ${gameStats[key].success} 顆 / 時間到 ${gameStats[key].fail} 顆 (達成率: ${rate}%)</li>`;
                    } else {
                        // 嘴型與舌頭模式的文字
                        html += `<li style="margin-bottom: 10px;"><strong>${key}</strong>: 成功 ${gameStats[key].success} 次 / 失敗 ${gameStats[key].fail} 次 (達成率: ${rate}%)</li>`;
                    }
                }
                html += '</ul>';
                statsPanel.innerHTML = html;
            }

            // 🌟 把結算統計送到 API 寫進 SQL Server,並在右上角顯示提示
            uploadStatsWithToast({
                playerName: playerName || localStorage.getItem('player_name') || 'Guest',
                mode: currentTrainingMode,
                difficulty: currentDifficulty,
                stats: gameStats,
            });
        } else {
            statusDisplay.innerText = "已離開教學模式，請選擇難度開始挑戰！";
        }
    }
}

// ==========================================
// 結算上傳 + 右上角浮動提示
// ==========================================
function showToast(text, type = 'info') {
    // type: 'info' (藍) / 'success' (綠) / 'error' (紅)
    let el = document.getElementById('upload-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'upload-toast';
        el.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 10000;
            padding: 12px 18px; border-radius: 10px;
            font-family: 'Microsoft JhengHei', sans-serif; font-size: 14px;
            font-weight: 600; color: #fff;
            box-shadow: 0 6px 20px rgba(0,0,0,0.25);
            transform: translateX(120%); transition: transform .3s ease;
            max-width: 280px; word-break: break-word;
        `;
        document.body.appendChild(el);
    }
    const colors = {
        info:    '#3498db',
        success: '#27ae60',
        error:   '#e74c3c',
    };
    el.style.background = colors[type] || colors.info;
    el.innerText = text;
    requestAnimationFrame(() => { el.style.transform = 'translateX(0)'; });
    clearTimeout(el._hideT);
    if (type !== 'info') {
        el._hideT = setTimeout(() => { el.style.transform = 'translateX(120%)'; }, 4000);
    }
}

// Azure App Service + SQL 冷啟動可能要 30~60 秒,分段重試涵蓋整個喚醒時間
const UPLOAD_RETRY_DELAYS = [5000, 15000, 30000];

async function uploadStatsWithToast(payload) {
    // 固定遊玩時間,重試或日後補傳都用同一個時間
    payload = { ...payload, playedAt: new Date().toISOString() };

    showToast('📤 上傳結算中…', 'info');
    let res = await sendGameStats(payload);
    for (let i = 0; i < UPLOAD_RETRY_DELAYS.length && isRetryable(res); i++) {
        showToast(`🔄 伺服器喚醒中,${UPLOAD_RETRY_DELAYS[i] / 1000} 秒後重試(${i + 1}/${UPLOAD_RETRY_DELAYS.length})…`, 'info');
        await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAYS[i]));
        res = await sendGameStats(payload);
    }
    if (res.ok) {
        showToast(`✅ 上傳成功 (#${res.id ?? '?'})`, 'success');
    } else if (isRetryable(res)) {
        // 重試都失敗:存到本機,下次開啟遊戲時自動補傳,紀錄不會遺失
        queuePendingStats(payload);
        showToast('⚠️ 暫時連不上伺服器,結算已存在本機,下次開啟遊戲會自動補傳', 'error');
    } else {
        const reason = res.error ? `:${res.error.slice(0, 80)}` : res.status ? ` (HTTP ${res.status})` : '';
        showToast(`❌ 上傳失敗${reason}`, 'error');
    }
}

// 開啟遊戲時補傳之前沒送出的結算(先喚醒後端再送)
async function flushPendingWithToast() {
    await pingApi();
    const sent = await flushPendingStats();
    if (sent > 0) showToast(`✅ 已補傳 ${sent} 筆之前未送出的結算`, 'success');
}

// ==========================================
// 4. 遊戲軌道與進度相關輔助函數
// ==========================================

// 📖 動態取得教學順序 (根據當前模式切換)
function getTutorialSequence() {
    if (currentTrainingMode === 'tongue') {
        return ["⬆️", "⬇️", "⬅️", "➡️", "⬆️", "⬇️", "⬅️", "➡️", "⬆️"];
    }
    if (currentTrainingMode === 'voice') {
        return voiceConfig.voiceTutorialTopic;
    }
    return ["ㄚ", "ㄧ", "ㄨ", "ㄚ", "ㄧ", "ㄨ", "ㄚ", "ㄧ", "ㄨ"];
}

function getSequence() {
    if (currentTrainingMode === 'tongue') {
        return ["⬆️", "⬇️", "⬅️", "➡️"];
    }
    if (currentTrainingMode === 'voice') {
        return ["PA", "TA", "KA", "LA"];
    }
    return ["ㄚ", "ㄧ", "ㄨ"];
}

function initQueue() {
    poseQueue = [];
    if (currentDifficulty === "tutorial") {
        // 新手教學題目
        const seq = getTutorialSequence();
        for (let i = 0; i < 6; i++) poseQueue.push(seq[i]);
    } else {
        // 初中高級題目
        let targetList = getSequence();
        for (let i = 0; i < 6; i++) poseQueue.push(targetList[Math.floor(Math.random() * targetList.length)]);
    }
    if(isGameRunning){
        renderBelt();
    } 
        
}

//依目前的題目佇列更新左邊 3D 的題目(嘴型/舌頭:沿小路飄來的泡泡;發聲:路上的巨石)
export function renderBelt() {
    if (poseQueue.length === 0) return;
    if (currentTrainingMode === 'voice') {
        // 新的一顆石頭:重設血量與限時
        voiceConfig.remainingHits = (currentDifficulty === 'tutorial') ? 1 : voiceConfig.MAX_HEALTH;//教學模式血量1
        voiceConfig.stoneTimeLeft = voiceConfig.STONE_TIME_LIMIT; //新石頭重新計時
    }
    world.setQueue(poseQueue);
    if (currentTrainingMode === 'voice') world.setStoneLabel(`剩餘 ${voiceConfig.remainingHits} 次`);
}

function startTurnTimer() {
    if (!isGameRunning || poseQueue.length === 0) return;
    const targetPose = poseQueue[0]; //當前題目
    const statusDisplay = document.getElementById("status-message");
    if (statusDisplay) statusDisplay.innerText = `${targetPose} 維持！！！`;
    accumulatedHoldTime = 0; 

    // 教學語音提示
    let spokenText = targetPose;
    if (currentTrainingMode === 'mouth') {
        spokenText = `請跟著喊：${targetPose}`
    } else if (currentTrainingMode === 'voice') {
        let targetString;
        if (targetPose === 'PA') targetString = '趴';
        else if (targetPose === 'TA') targetString = '他';
        else if (targetPose === 'KA') targetString = '咖';
        else if (targetPose === 'LA') targetString = '拉';
        spokenText = `大聲喊出：${targetString}`
    } else if (currentTrainingMode === 'tongue') {
        if (targetPose === '⬆️') spokenText = '舌頭往上';
        else if (targetPose === '⬇️') spokenText = '舌頭往下';
        else if (targetPose === '⬅️') spokenText = '舌頭往左';
        else if (targetPose === '➡️') spokenText = '舌頭往右';
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = "zh-TW";

    let lockThreshold = 4; //設定教學模式前面多少題要聽完語音才能動作
    if (currentTrainingMode === 'mouth') {
        lockThreshold = 3;
    } else if (currentTrainingMode === 'voice') {
        voiceConfig.lockThreshold = 4;
    } else if (currentTrainingMode === 'tongue') {
        lockThreshold = 4;
    }

    const myTurn = ++turnToken;
    if (currentDifficulty === "tutorial" && tutorialIndex < lockThreshold) {
        //處於教學模式，且關卡還沒超過門檻，嚴格鎖定防搶拍
        isTutorialLocked = true;
        world.setLocked(true); //目前這題加上 🚫
        const unlock = () => {
            // 上一題被 cancel() 的語音也會觸發 onend/onerror,不能拿來解鎖新的題目
            if (myTurn !== turnToken) return;
            isTutorialLocked = false; // 語音乖乖唸完後，才解鎖讓玩家動作
            world.setLocked(false);
        };
        utterance.onend = unlock;
        utterance.onerror = unlock; // 沒有中文語音包、被瀏覽器擋下時會走 onerror
        // iOS / 部分 Android 可能完全不觸發 onend,時間到就強制解鎖,避免永遠卡在 🚫
        setTimeout(unlock, Math.max(2500, spokenText.length * 350) + 1500);
        // ✅ 只有在教學模式，且遊戲真的在跑，才說話
        if (isGameRunning) {
            window.speechSynthesis.speak(utterance);
        }
        
    } else {
        //已經超過教學門檻，不鎖定，可邊聽邊做或直接做
        isTutorialLocked = false;
        world.setLocked(false); // 確保不需要鎖定時,題目絕對不會卡著禁止符號
    }
}

// 過關/失敗處理器
export function triggerResult(isSuccess) {
    if (!isGameRunning) return; // 遊戲已經結束(例如石頭碎掉的動畫期間按了結束遊戲)

    if (isSuccess) {
        if (currentTrainingMode !== 'voice') playSuccessSound(); // 過關音效(發聲模式在石頭碎掉的當下就播了)
        gameStats[poseQueue[0]] && gameStats[poseQueue[0]].success++;//類計成功次數
    } else {
        gameStats[poseQueue[0]] && gameStats[poseQueue[0]].fail++; //類計失敗次數
    }
    // 3D:成功 → 泡泡破掉 + 紙屑;失敗 → 泡泡變紅消散 / 石頭沉進地面。後面的題目同時往前推進
    world.resolve(isSuccess);

    const round = gameRound;
    setTimeout(() => {
        if (!isGameRunning || round !== gameRound) return; // 這段時間內遊戲結束或重新開局了
        poseQueue.shift(); // 移除已經判定過的目標
        
        // 👇 徹底分流：確保教學結束就是結束，一般模式就是無限隨機
        if (currentDifficulty === "tutorial") { 
            tutorialIndex++;
            if (tutorialIndex >= 9) { //教學題目共9提超過9題就結束
                endGame();
                const statusDisplay = document.getElementById("status-message");
                if (statusDisplay) statusDisplay.innerText = "🎉 新手教學完成！請選擇難度開始挑戰！";
                return; 
            }
            const seq = getTutorialSequence(); //取得各模式教學題目庫
            
            let nextItemIndex = tutorialIndex + 5; //輸送帶總共會顯示5到6個題目
            if (nextItemIndex < seq.length) {
                poseQueue.push(seq[nextItemIndex]); //讓玩家能看到後續的題目
            }
            
        } else {
            // 一般難度的無限替補
            let targetList = getSequence();//取得一般模式題目庫
            poseQueue.push(targetList[Math.floor(Math.random() * targetList.length)]);//隨機塞入題目
        }

        renderBelt();  //根據更新後的 poseQueue 更新 3D 的題目(補上最後面新的一題)
        startTurnTimer(); //負責推進遊戲的「流程與邏輯」
    }, 500); //等泡泡破掉、後面的題目往前推進的動畫
}

function changeUIshow(){
const els = {
        "tutorial-controls": "none",
        "start-controls": "none",
        "history-controls": "none",
        "game-controls": "flex",
        "stats-panel": "none",
        "audio-meter-container": "flex" ,
        "mode-mouth":"none", //嘴型訓練按鈕
        "mode-voice":"none", //發聲訓練按鈕
        "mode-tongue":"none", //舌頭訓練按鈕
        "hint-message":"flex", //遊戲內提示文字
        "game-title":"none" //遊戲標題
    };
    for (let id in els) {
        let el = document.getElementById(id);
        if (el) el.style.display = els[id];
    }
}

/**
 * 🧹 全域偵測清理器
 * 負責把所有正在運行的偵測引擎（語音、模型、計時器）徹底關閉
 */
function stopAllEngines() {
    isGameRunning = false;
    stopMouthDetection();
    stopTfjsDetection();
    stopVoiceDetection();
}
// =========================================
// 玩家名稱輸入(先) → 啟動系統(後)
// =========================================
function askPlayerName() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('player-name-overlay');
    const input   = document.getElementById('player-name-input');
    const errEl   = document.getElementById('player-name-error');
    const submit  = document.getElementById('player-name-submit');
    if (!overlay || !input || !submit) { resolve('Guest'); return; }

    // 嘗試讀上次的名字(localStorage)
    const last = localStorage.getItem('player_name');
    if (last) input.value = last;
    setTimeout(() => input.focus(), 100);

    const finish = () => {
      const name = input.value.trim();
      if (!name) { errEl.textContent = '請輸入名字喔!'; input.focus(); return; }
      if (name.length > 20) { errEl.textContent = '名字最長 20 字'; return; }
      localStorage.setItem('player_name', name);
      playerName = name;
      overlay.style.display = 'none';
      resolve(name);
    };
    submit.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
  });
}

// 載入失敗時把「正在召喚…」換成原因 + 重新整理按鈕,不再卡在載入畫面
function showInitError(err) {
  const loading = document.getElementById('loading-overlay');
  if (!loading) return;

  let msg = '載入失敗,請確認網路連線正常後重新整理。';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    msg = '需要攝影機與麥克風權限才能進行遊戲。請在瀏覽器網址列旁允許權限後,重新整理頁面。';
  } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    msg = '找不到攝影機或麥克風,請確認裝置已連接後重新整理。';
  } else if (err?.name === 'NotReadableError') {
    msg = '攝影機或麥克風正在被其他程式使用,請先關閉其他視訊程式後重新整理。';
  }

  loading.innerHTML = '';
  loading.style.display = '';
  loading.style.flexDirection = 'column';
  loading.style.gap = '20px';
  loading.style.padding = '24px';
  loading.style.textAlign = 'center';

  const text = document.createElement('div');
  text.textContent = '😢 ' + msg;
  const retry = document.createElement('button');
  retry.textContent = '🔄 重新整理';
  retry.addEventListener('click', () => location.reload());
  loading.append(text, retry);
}

// 進首頁前先拿到名字,再啟動 3D / MediaPipe / 模型載入
(async () => {
  // 玩家輸入名字的同時,先喚醒後端並補傳上次沒送出的結算
  flushPendingWithToast();

  await askPlayerName();
  const loading = document.getElementById('loading-overlay');
  if (loading) loading.style.display = '';   // 還原 CSS 預設樣式
  try {
    await startSystem();
  } catch (err) {
    console.error('❌ 系統初始化失敗:', err);
    showInitError(err);
  }
})();