// js/mode_mouth.js
import * as THREE from 'three';
import { currentVrm, currentTrainingMode, isGameRunning, currentDifficulty, DIFFICULTY_CONFIG, poseQueue, isTutorialLocked, triggerResult, world } from './app.js';
import { onFaceFrame } from './face_tracker.js';
import { isMicOpen, readVolume, noiseFloor, updateThresholdLine } from './audio.js';
import { smoothToward, createMatchFilter } from './judge_utils.js';
import { debugShow } from './debug_panel.js';

let isDetecting = false;

// 遊戲狀態控制
let holdTime = 0;
let turnTimeLeft = 5000;
let lastTarget = "";
let lastTime = performance.now();
let wasMatched = false;                  // 上一刻是否做對(用來放寬門檻,避免在門檻附近一直跳)
const matchFilter = createMatchFilter(250);

// 平滑後的嘴型數值;SHAPE_TAU 越大越平穩、反應越慢(60ms 約等於平均最近 2~3 張畫面)
const shape = { jaw: 0, pucker: 0, funnel: 0, wide: 0 };
const SHAPE_TAU = 60;

// 兩張畫面的最大間隔(ms):切換分頁回來時避免計時器一次跳好幾秒
const MAX_DT = 250;

// 麥克風音量偵測
let smoothedVolume = 0;
export let isMicEnabled = false; // 麥克風本身由 audio.js 按需開關;這裡只記錄「語音判定」開關

export function startMouthDetection() {
    if (isDetecting) return;
    isDetecting = true;
    lastTime = performance.now(); //這是一個極度精確的瀏覽器計時器這通常用來計算 兩幀之間的經過時間，或是用來判斷玩家 維持某個嘴型持續了幾秒鐘
    onFaceFrame(handleFaceFrame); // 由共用的臉部偵測迴圈每張新畫面呼叫一次
}

export function stopMouthDetection() {
    lastTarget = "";
}

export function setMicStatus(status) {
    isMicEnabled = status;
    const micBtn = document.getElementById("toggleMicBtn");
    if (micBtn) {
        if (status) {
            micBtn.innerText = '🎙️ 語音判定：開啟';
            micBtn.classList.remove('off');
        } else {
            micBtn.innerText = '🎙️ 語音判定：關閉';
            micBtn.classList.add('off');
        }
    }
    if (!status) {
        smoothedVolume = 0;
        const meterFill = document.getElementById("meter-fill");
        if (meterFill) meterFill.style.width = "0%";
    }
}


// 從 MediaPipe 的表情係數取出判斷嘴型要用的量(0~1)
function readMouthShape(categories) {
    const s = {};
    for (const c of categories) s[c.categoryName] = c.score;
    return {
        jaw: s.jawOpen || 0,
        pucker: s.mouthPucker || 0,
        funnel: s.mouthFunnel || 0,
        // ㄧ:嘴角往兩側拉。左右兩邊都看、取比較明顯的一邊(頭稍微轉向時,離鏡頭遠的那邊會被低估)
        wide: Math.max(s.mouthStretchLeft || 0, s.mouthStretchRight || 0, s.mouthSmileLeft || 0, s.mouthSmileRight || 0),
    };
}

// 各嘴型「做到幾成」:1 = 剛好達到這個難度的門檻。
// 每個嘴型只看自己的條件(不再用「先判 ㄨ、再判 ㄚ、最後才判 ㄧ」的順序,避免 ㄧ 被前面的條件吃掉)。
// keep:上一刻已經做對時門檻放寬 15%,數值在門檻附近抖動時才不會一下對、一下錯
function shapeRatios(sh, conf, keep) {
    const k = keep ? 0.85 : 1;
    return {
        'ㄚ': sh.pucker < 0.4 ? sh.jaw / (conf.jaw_A * k) : 0,
        'ㄨ': sh.jaw < 0.45 ? sh.pucker / (conf.pucker_U * k) : 0,
        'ㄧ': sh.pucker < 0.35 ? sh.wide / (conf.stretch_I * k) : 0,
    };
}

// AI 辨識與遊戲邏輯:每張新的鏡頭畫面執行一次
function handleFaceFrame(results, now) {
    const dt = Math.min(now - lastTime, MAX_DT);
    lastTime = now;

    // 1. 全域音量計算與 UI
    if (isMicEnabled && isMicOpen()) {
        const volume = readVolume();
        // 依實際間隔換算平滑係數,讓反應速度跟原本 60fps 時一樣,不受鏡頭幀率影響
        const k = 1 - Math.pow(0.8, dt / 16.7);
        smoothedVolume = smoothedVolume * (1 - k) + volume * k;

        const meterFill = document.getElementById("meter-fill");
        if (meterFill && currentDifficulty !== "easy" && currentTrainingMode === 'mouth') {
            meterFill.style.width = Math.min((smoothedVolume / 80) * 100, 100) + "%";
            meterFill.style.backgroundColor = "#3498db";
            updateThresholdLine(DIFFICULTY_CONFIG[currentDifficulty].volThreshold);
        }
    }

    // =========================================
    // 🌟 第一階段：物理連動(人物跟著玩家的嘴型與頭部動)
    // =========================================
    const hasFace = !!(results.faceBlendshapes && results.faceBlendshapes.length > 0);
    if (hasFace) {
        // 每張畫面的數值本來就會抖,先做短時間平滑再判斷
        const raw = readMouthShape(results.faceBlendshapes[0].categories);
        for (const key in shape) shape[key] = smoothToward(shape[key], raw[key], dt, SHAPE_TAU);

        if (currentVrm) {
            currentVrm.expressionManager.setValue('aa', shape.jaw);
            currentVrm.expressionManager.setValue('ou', shape.pucker);
            currentVrm.expressionManager.setValue('ih', shape.wide);
            currentVrm.expressionManager.setValue('oh', shape.funnel);
        }
    }

    if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
        const matrix = new THREE.Matrix4().fromArray(results.facialTransformationMatrixes[0].data);
        const rotation = new THREE.Euler().setFromRotationMatrix(matrix);

        if (currentVrm) {
            const head = currentVrm.humanoid.getNormalizedBoneNode('head');
            const neck = currentVrm.humanoid.getNormalizedBoneNode('neck');
            if (head && neck) {
                let pitch = rotation.x;
                let yaw = -rotation.y;
                let roll = -rotation.z;

                head.rotation.set(pitch * 0.5, yaw * 0.5, roll * 0.5);
                neck.rotation.set(pitch * 0.5, yaw * 0.5, roll * 0.5);
            }
        }
    }

    // =========================================
    // 🎮 第二階段：遊戲判定 (形音雙重驗證)
    // =========================================
    if (currentTrainingMode !== 'mouth' || !isGameRunning || poseQueue.length === 0) return;

    const targetPose = poseQueue[0];
    const conf = DIFFICULTY_CONFIG[currentDifficulty];
    const hintMessage = document.getElementById("hint-message");
    const setHint = (text, color) => { if (hintMessage) { hintMessage.innerText = text; hintMessage.style.color = color; } };

    if (targetPose !== lastTarget) {
        lastTarget = targetPose;
        holdTime = 0;
        turnTimeLeft = 5000;
        wasMatched = false;
        matchFilter.reset();
    }

    // 找不到臉(離開鏡頭、被手擋住):暫停計時,不算玩家做錯
    if (!hasFace) {
        setHint("🙂 找不到臉,請把臉對準鏡頭", "#ffffff");
        debugShow('嘴型', { 目標: targetPose, 臉: '找不到' });
        return;
    }

    // 驗證 1：嘴型
    const ratios = shapeRatios(shape, conf, wasMatched);
    const isFaceMatched = (ratios[targetPose] || 0) >= 1;
    const best = Object.keys(ratios).reduce((a, b) => (ratios[a] >= ratios[b] ? a : b));
    const detected = ratios[best] >= 1 ? best : "";

    // 驗證 2：聲音(只要麥克風收到夠大的聲音就給過;扣掉背景噪音,被收進來的背景音樂不算玩家的聲音)
    const checkVoice = isMicEnabled && currentDifficulty !== "easy";
    const voiceThreshold = conf.volThreshold * (wasMatched ? 0.8 : 1) + noiseFloor;
    const isVoiceMatched = !checkVoice || smoothedVolume > voiceThreshold;

    // 短暫閃掉(0.25 秒內)不算中斷:不累積、不扣時間,也不歸零
    const state = isTutorialLocked ? 'miss' : matchFilter.update(isFaceMatched && isVoiceMatched, now);
    wasMatched = state !== 'miss';

    debugShow('嘴型', {
        目標: targetPose,
        '張嘴 (ㄚ)': `${shape.jaw.toFixed(2)} / 門檻 ${conf.jaw_A}`,
        '嘟嘴 (ㄨ)': `${shape.pucker.toFixed(2)} / 門檻 ${conf.pucker_U}`,
        '嘴角拉開 (ㄧ)': `${shape.wide.toFixed(2)} / 門檻 ${conf.stretch_I}`,
        '目標達成度': `${Math.round((ratios[targetPose] || 0) * 100)}%`,
        聲音: checkVoice ? `${smoothedVolume.toFixed(0)} / 門檻 ${voiceThreshold.toFixed(0)}` : '不判定',
        判定: { match: '✅ 做對', grace: '⏸ 短暫閃掉', miss: '❌ 沒做對' }[state],
        維持: `${Math.round(holdTime)} / ${conf.holdDuration} ms`,
    });

    if (isTutorialLocked) {
        setHint("🔊 請先聽完語音指示喔！", "#8e44ad");
        holdTime = 0;
        world.setProgress(0);
        return;
    }

    if (state === 'match') {
        setHint(checkVoice ? "👍 動作很棒！請保持住！" : "👍 嘴型很棒！請保持住！", "#f1c40f");
        world.setWarning(false);

        holdTime += dt;
        world.setProgress(holdTime / conf.holdDuration); // 目標圈的綠色進度弧,泡泡也漸漸變綠

        if (holdTime >= conf.holdDuration) {
            triggerResult(true);
            lastTarget = "";
        }
        return;
    }
    if (state === 'grace') return;

    if (isFaceMatched && !isVoiceMatched) {
        setHint("🎤 嘴型對了！請記得大聲發出聲音喔！", "#ffffff");
    } else if (detected && detected !== targetPose) {
        setHint(`🤔 動作不太對喔！(偵測到: ${detected})`, "#ffffff");
    } else if ((ratios[targetPose] || 0) >= 0.6) {
        setHint(`💪 快到了！${targetPose} 的嘴型再明顯一點`, "#ffffff"); // 讓玩家知道方向對了,只差一點
    } else {
        setHint("😶 預備！請看著符號，做出動作！", "#ffffff");
    }
    if (!conf.accumulateProgress) {
        holdTime = 0;
        world.setProgress(0);
    }
    if (!conf.isTutorial) {
        turnTimeLeft -= dt;
        if (turnTimeLeft <= 2000) world.setWarning(true); // 剩 2 秒:泡泡與目標圈閃紅
        if (turnTimeLeft <= 0) {
            triggerResult(false);
            lastTarget = "";
        }
    }
}
