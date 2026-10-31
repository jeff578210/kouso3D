// js/mode_mouth.js
import * as THREE from 'three';
import { currentVrm, currentTrainingMode, isGameRunning, currentDifficulty, DIFFICULTY_CONFIG, poseQueue, isTutorialLocked, triggerResult,globalStream} from './app.js';
import { onFaceFrame } from './face_tracker.js';

let isDetecting = false;

// 遊戲狀態控制
let holdTime = 0;
let turnTimeLeft = 5000;
let lastTarget = "";
let lastTime = performance.now();

// 兩張畫面的最大間隔(ms):切換分頁回來時避免計時器一次跳好幾秒
const MAX_DT = 250;

// 麥克風音量偵測
let smoothedVolume = 0;
export let audioContext;
export let analyser;
export let dataArray;
export let isMicEnabled = false;

export function resumeAudio() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => console.log("🔊 音訊系統已成功喚醒！"));
    }
}

// 初始化麥克風音量分析
export async function initMouthMode() {


    //做 音量跳動條 或是判斷玩家 有沒有發出聲音
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();  //Web Audio元件
        analyser = audioContext.createAnalyser(); //頻譜分析元件 音量大小、頻率高低轉換成數據
        const source = audioContext.createMediaStreamSource(globalStream); //音訊來源
        source.connect(analyser);//音源連接分析元件
        analyser.fftSize = 256; //分析解析度頻率
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        isMicEnabled = true;

    } catch (err) {
        console.error("無法取得攝影機或麥克風權限", err);
        isMicEnabled = false;
    }

    console.log("✅ 嘴型模式初始化完成");
}

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
    if (!status && analyser) {
        smoothedVolume = 0;
        const meterFill = document.getElementById("meter-fill");
        if (meterFill) meterFill.style.width = "0%";
    }
}

// AI 辨識與遊戲邏輯:每張新的鏡頭畫面執行一次
function handleFaceFrame(results, now) {
    const dt = Math.min(now - lastTime, MAX_DT);
    lastTime = now;

    // 1. 全域音量計算與 UI
    if (isMicEnabled && analyser) {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        // 依實際間隔換算平滑係數,讓反應速度跟原本 60fps 時一樣,不受鏡頭幀率影響
        const k = 1 - Math.pow(0.8, dt / 16.7);
        smoothedVolume = smoothedVolume * (1 - k) + (sum / dataArray.length) * k;

        const meterFill = document.getElementById("meter-fill");
        if (meterFill && currentDifficulty !== "easy" && currentTrainingMode === 'mouth') {
            meterFill.style.width = Math.min((smoothedVolume / 80) * 100, 100) + "%";
            meterFill.style.backgroundColor = "#3498db";
        }
    }

    // =========================================
    // 🌟 第一階段：物理連動 (維持你原本的完美設計)
    // =========================================
    let jawOpen = 0, mouthPucker = 0, mouthStretch = 0, mouthSmile = 0, mouthFunnel = 0;

    if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
        const shapes = results.faceBlendshapes[0].categories;
        jawOpen = shapes.find(s => s.categoryName === "jawOpen")?.score || 0;
        mouthPucker = shapes.find(s => s.categoryName === "mouthPucker")?.score || 0;
        mouthStretch = shapes.find(s => s.categoryName === "mouthStretchLeft")?.score || 0;
        mouthSmile = shapes.find(s => s.categoryName === "mouthSmileLeft")?.score || 0;
        mouthFunnel = shapes.find(s => s.categoryName === "mouthFunnel")?.score || 0;

        if (currentVrm) {
            currentVrm.expressionManager.setValue('aa', jawOpen);
            currentVrm.expressionManager.setValue('ou', mouthPucker);
            currentVrm.expressionManager.setValue('ih', Math.max(mouthStretch, mouthSmile));
            currentVrm.expressionManager.setValue('oh', mouthFunnel);
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
    if (currentTrainingMode === 'mouth' && isGameRunning && poseQueue.length > 0) {
        const targetPose = poseQueue[0];
        const conf = DIFFICULTY_CONFIG[currentDifficulty];

        if (targetPose !== lastTarget) {
            lastTarget = targetPose;
            holdTime = 0;
            turnTimeLeft = 5000;
        }

        // 驗證 1：臉部動作是否正確？(保留你原本的 MediaPipe 參數邏輯)

        let detected = "";
        if (jawOpen < 0.08 && mouthPucker < 0.5 && mouthStretch < 0.4) {
            // 預設狀態
            detected = "";
        } else if (mouthPucker > conf.pucker_U && jawOpen < 0.4) {
            detected = "ㄨ";
        } else if (jawOpen > conf.jaw_A && mouthPucker < 0.3) {
            detected = "ㄚ";
        } else if (mouthStretch > conf.stretch_I || mouthSmile > conf.stretch_I) {
            detected = "ㄧ";
        }

        let isFaceMatched = (detected === targetPose);

        // 驗證 2：聲音內容是否正確？
        let isVoiceMatched = true;
        if (isMicEnabled && currentDifficulty !== "easy") {
            // 不再檢查字有沒有唸對，只要麥克風有收到夠大的聲音就給過
            isVoiceMatched = (smoothedVolume > conf.volThreshold);
        }

        const hintMessage = document.getElementById("hint-message");
        const currentBubble = document.getElementById("bubble-0");
        if (isTutorialLocked) {
            if(hintMessage) {
                hintMessage.innerText = "🔊 請先聽完語音指示喔！";
                hintMessage.style.color = "#8e44ad";
            }
            holdTime = 0;
            if(currentBubble) currentBubble.style.background = "";
        } else {
            if (isFaceMatched && isVoiceMatched) {
                if(hintMessage) {
                    hintMessage.innerText = isMicEnabled && currentDifficulty !== "easy" ? "👍 動作很棒！請保持住！" : "👍 嘴型很棒！請保持住！";
                    hintMessage.style.color = "#f1c40f";
                }
                if (currentBubble) currentBubble.classList.remove("warning-blink");

                holdTime += dt;
                let progress = Math.min(holdTime / conf.holdDuration, 1) * 100;
                if(currentBubble) {
                    currentBubble.style.background = `linear-gradient(to top, #2ecc71 ${progress}%, #3498db ${progress}%)`;
                    currentBubble.style.transform = "scale(1.15)";
                }

                if (holdTime >= conf.holdDuration) {
                    triggerResult(true);
                    lastTarget = "";
                }
            } else {
                if(hintMessage) {
                    if (isFaceMatched && !isVoiceMatched) {
                        hintMessage.innerText = "🎤 嘴型對了！請記得大聲發出聲音喔！";
                    } else {
                        hintMessage.innerText = detected === "" ? "😶 預備！請看著符號，做出動作！" : `🤔 動作不太對喔！(偵測到: ${detected})`;
                    }
                    hintMessage.style.color = "#ffffff";
                }
                if (!conf.accumulateProgress) {
                    holdTime = 0;
                    if(currentBubble) { currentBubble.style.background = ""; currentBubble.style.transform = "scale(1)"; }
                }
                if (!conf.isTutorial) {
                    turnTimeLeft -= dt;
                    if (turnTimeLeft <= 2000 && currentBubble) currentBubble.classList.add("warning-blink");
                    if (turnTimeLeft <= 0) {
                        triggerResult(false);
                        lastTarget = "";
                    }
                }
            }
        }
    }
}
