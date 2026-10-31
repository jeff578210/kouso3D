// js/mode_voice.js
import { currentVrm, currentTrainingMode, isGameRunning, isTutorialLocked, gameStats, poseQueue, triggerResult ,currentDifficulty ,renderBelt,getVolumeLevel, DIFFICULTY_CONFIG} from './app.js';
import { isMicOpen, readVolume, noiseFloor, updateThresholdLine } from './audio.js';
import { onFaceFrame } from './face_tracker.js';

let isDetecting = false; //檢查遊戲有沒有再進行
let isFrameHandlerRegistered = false; //只向共用臉部偵測註冊一次,避免每局疊加一條迴圈
let currentTargetSyllable; //當前題目
let hitCooldown = false; //防止連擊
let isWaitingForNextSound = false; //防止連擊
let loudMs = 0; //聲音連續超過門檻多久(ms)
const MIN_LOUD_MS = 60; //至少持續這麼久才算一次敲擊。只擋得住極短的雜訊:瀏覽器音量分析會讓大聲突波拖尾約 0.3 秒,較長的突波仍會通過
let lastTime = performance.now();
const MAX_DT = 250; //兩張畫面的最大間隔(ms):切換分頁回來時避免計時器一次跳好幾秒
let recognition = null;  //語音偵測物件
let recognizer; //擴充庫物件
let isTfjsRunning = false; //Teachable Machine是否執行中
export let isVoskRunning = false;
export const voiceConfig = {
    id: 'mouth',
    voiceTutorialTopic: ["PA", "TA", "KA", "LA", "PA", "TA", "KA", "LA"], //教學模式題庫
    lockThreshold:4, //設定教學模式前面多少題要聽完語音才能動作
    MAX_HEALTH : 5,//預設石頭最大血量
    remainingHits : 1, //預設石頭當前血量
    STONE_TIME_LIMIT : 10000, //每顆石頭的限時(ms),時間到沒敲碎就算失敗(教學模式不限時)
    stoneTimeLeft : 10000, //目前這顆石頭剩下的時間
    stoneAnimState : "normal"// 記錄石頭動畫狀態 "normal", "hit", "explode"
};

// 語音辨識庫
const SYLLABLE_MAP = {
    "PA": ["pa", "趴", "怕", "啪", "叭", "吧", "巴", "把", "爸", "發", "爬", "帕", "哈", "八", "拔", "潘", "判", "旁", "胖", "派", "拍", "阿", "啊"],
    "TA": ["ta", "他", "她", "它", "踏", "塔", "大", "打", "答", "達", "太", "探", "塌", "沓", "特", "搭", "代"],
    "KA": ["ka", "卡", "喀", "咖", "咔", "嘎", "尬", "ga", "擦", "哈", "看", "ㄎ", "可", "克", "客", "渴", "考", "靠"],
    "LA": ["la", "拉", "啦", "喇", "辣", "拿", "哪", "納", "藍", "落", "來", "哩", "了", "老", "na", "那", "男"]
};


// 在你的 startGame 函式中呼叫 startTfjsDetection()，
// 並在 stopAllEngines 或 gameOver 時呼叫 stopTfjsDetection()。
// 1. 初始化模型
export async function initTfjsVoice() {
    // 這裡指向你存放模型檔案的路徑
    const currentPath = window.location.href.substring(0, window.location.href.lastIndexOf('/'));

    // 語音模型
    const VOICE_URL = currentPath + "/tm_model/voice/";
    const checkpointURL = VOICE_URL + "model.json";
    const metadataURL = VOICE_URL + "metadata.json";

    try {
        recognizer = speechCommands.create(
            "BROWSER_FFT", // 使用瀏覽器內建的傅立葉轉換
            undefined, 
            checkpointURL, 
            metadataURL
        );

        // 確保模型載入完成
        await recognizer.ensureModelLoaded();
        console.log("✅ TF.js 模型載入成功！標籤：", recognizer.wordLabels());
    } catch (error) {
        console.error("❌ 模型載入失敗:", error);
    }
}

// 2. 啟動監聽
export async function startTfjsDetection() {
     window.addEventListener('keydown', (event) => {
        switch(event.code) {
            case 'Space': 
            console.log(`🎯 命中目標音`);
            triggerStoneHit();
            try { recognition.stop(); } catch(e){}
            break; 
        }
    });
    if (!recognizer || isTfjsRunning) return;

    isTfjsRunning = true;

    // listen() 會啟動麥克風並持續回傳結果
    await recognizer.listen(result => {
        const scores = result.scores; // 每個標籤的信心機率陣列
        const labels = recognizer.wordLabels(); // 你的標籤陣列
        
        // 找出最高分的索引
        let maxIndex = 0;
        let maxScore = 0;
        for (let i = 0; i < scores.length; i++) {
            if (scores[i] > maxScore) {
                maxScore = scores[i];
                maxIndex = i;
            }
        }

        const detectedWord = labels[maxIndex];

        // 🌟 判定門檻：信心度必須超過 0.85，且不是「背景雜音」
        if (maxScore > 0.85 && detectedWord !== "_background_noise_") {
            console.log(`🎯 偵測到音節: ${detectedWord} (信心度: ${(maxScore * 100).toFixed(1)}%)`);
            
            // 呼叫你的遊戲邏輯，例如：
            // handleHit(detectedWord); 
        }
    }, {
        includeSpectrogram: false, // 遊戲不需要視覺頻譜，關閉以節省效能
        probabilityThreshold: 0.75, // 核心過濾門檻
        overlapFactor: 0.5, // 偵測視窗重疊率，0.5 代表反應較快
        invokeCallbackOnNoiseAndUnknown: false
    });
}

// 3. 停止監聽
export function stopTfjsDetection() {
    if (recognizer && isTfjsRunning) {
        recognizer.stopListening();
        isTfjsRunning = false;
        console.log("🔇 已關閉語音監聽");
    }
}


export function startVoiceDetection() {
    if (isDetecting) return;
    isDetecting = true;

    // 判定由共用的臉部偵測迴圈每張新畫面呼叫一次;停止時只關 isDetecting,不會殘留迴圈
    if (!isFrameHandlerRegistered) {
        isFrameHandlerRegistered = true;
        onFaceFrame(handleFaceFrame);
    }
}

export function stopVoiceDetection() {
    isDetecting = false;
    if (recognition) { try { recognition.stop(); } catch(e){} }
}

function handleFaceFrame(results, now) {
    const dt = Math.min(now - lastTime, MAX_DT);
    lastTime = now;
    if (!isDetecting || currentTrainingMode !== 'voice') return;

    let currentVolume = 0;
    let volumeLevel = getVolumeLevel();
    if (isMicOpen()) {
        currentVolume = readVolume();

        // 🌟 核心修復 3：改抓正確的 ID `meter-fill`
        const meterFill = document.getElementById("meter-fill");
        if (meterFill) {
            meterFill.style.width = Math.min((currentVolume / 80) * 100, 100) + "%";
            meterFill.style.backgroundColor = "#e74c3c"; // 發聲模式專屬的紅色音量條
        }
        updateThresholdLine(volumeLevel);
    }

    let jawOpen = 0, mouthPucker = 0, mouthStretch = 0, mouthSmile = 0, mouthFunnel = 0;

    if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
        const shapes = results.faceBlendshapes[0].categories;
        jawOpen = shapes.find(s => s.categoryName === "jawOpen")?.score || 0;
    }
    // 門檻都以背景噪音為基準(被收進來的背景音樂、音效不算玩家的聲音)
    if (currentVolume > volumeLevel + noiseFloor) {
        loudMs += dt;
        // 張嘴 + 聲音持續一小段時間才算(閉著嘴時的拍手、碰撞聲本來就不會觸發)
        if (!isWaitingForNextSound && jawOpen > 0.1 && !hitCooldown && loudMs >= MIN_LOUD_MS) {
            triggerStoneHit();
            isWaitingForNextSound = true; // 聲音上鎖
        }
    }
    else {
        loudMs = 0;
        if (currentVolume < noiseFloor + volumeLevel * 0.4) { // 聲音降回背景音量附近才解鎖,吵雜環境也不會卡住
            if (isWaitingForNextSound && !hitCooldown) {
                isWaitingForNextSound = false;
            }
        }
    }

    updateStoneTimer(dt);
}

// ⏱️ 每顆石頭限時:時間到還沒敲碎就算失敗(教學模式不限時;石頭碎掉等動畫時也不計時)
function updateStoneTimer(dt) {
    const conf = DIFFICULTY_CONFIG[currentDifficulty];
    if (!isGameRunning || conf.isTutorial || voiceConfig.remainingHits <= 0) return;

    voiceConfig.stoneTimeLeft -= dt;
    const stone = document.getElementById("stone-container");
    const hp = document.getElementById("stone-hp");
    const secondsLeft = Math.max(0, Math.ceil(voiceConfig.stoneTimeLeft / 1000));
    if (hp) hp.innerText = `剩餘 ${voiceConfig.remainingHits} 次 · ⏱️ ${secondsLeft} 秒`;
    if (stone) stone.classList.toggle("stone-warning", voiceConfig.stoneTimeLeft <= 3000);

    if (voiceConfig.stoneTimeLeft <= 0) {
        voiceConfig.remainingHits = 0; // 換下一顆石頭前,這顆不能再被敲到
        if (stone) stone.classList.remove("stone-warning");
        triggerResult(false);
    }
}



function triggerStoneHit() {
    if (hitCooldown || voiceConfig.remainingHits <= 0) return; // 石頭已碎或時間到,等下一顆
    hitCooldown = true;
    voiceConfig.remainingHits--; //將這顆石頭的剩餘需要打擊次數減 1。
    const stone = document.getElementById("stone-container");
    const hp = document.getElementById("stone-hp");

    if (voiceConfig.remainingHits > 0) {//石頭扣寫
        stone.classList.add("stone-hit");
        setTimeout(() => { stone.classList.remove("stone-hit"); hitCooldown = false; }, 400);
        hp.innerText = `剩餘 ${voiceConfig.remainingHits} 次`;
    } else {
        stone.classList.add("stone-explode"); //石頭破碎動畫
        if (gameStats && gameStats[currentTargetSyllable]) gameStats[currentTargetSyllable].success++; //寫入統計數據成功與失敗次數
        setTimeout(() => {
            hitCooldown = false; //解開連擊鎖
            triggerResult(true); //紀錄過關
        }, 1000); // 給予1秒鐘的時間顯示爆炸動畫
    }
}