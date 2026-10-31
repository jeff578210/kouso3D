// js/mode_mouth.js
import * as THREE from 'three';
import { currentVrm, currentTrainingMode, isGameRunning, currentDifficulty, DIFFICULTY_CONFIG, poseQueue, isTutorialLocked, triggerResult, world } from './app.js';
import { onFaceFrame } from './face_tracker.js';
import { isMicOpen, readVolume, noiseFloor, updateThresholdLine } from './audio.js';

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
            // (扣掉背景噪音:被收進來的背景音樂不算玩家的聲音)
            isVoiceMatched = (smoothedVolume > conf.volThreshold + noiseFloor);
        }

        const hintMessage = document.getElementById("hint-message");
        if (isTutorialLocked) {
            if(hintMessage) {
                hintMessage.innerText = "🔊 請先聽完語音指示喔！";
                hintMessage.style.color = "#8e44ad";
            }
            holdTime = 0;
            world.setProgress(0);
        } else {
            if (isFaceMatched && isVoiceMatched) {
                if(hintMessage) {
                    hintMessage.innerText = isMicEnabled && currentDifficulty !== "easy" ? "👍 動作很棒！請保持住！" : "👍 嘴型很棒！請保持住！";
                    hintMessage.style.color = "#f1c40f";
                }
                world.setWarning(false);

                holdTime += dt;
                world.setProgress(holdTime / conf.holdDuration); // 目標圈的綠色進度弧,泡泡也漸漸變綠

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
        }
    }
}
