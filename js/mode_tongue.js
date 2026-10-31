// js/mode_tongue.js
// === 用 U-Net 分割模型取代原本的 Teachable Machine 系統 ===
// ✦ export 介面與遊戲邏輯與原版 100% 相同,app.js 不用修改
// ✦ TF.js 4 透過 ESM CDN 動態載入,不影響 index.html 上既有的 tfjs@1.3.1(供 speech-commands 用)
// ✦ 原版備份在 mode_tongue.js.bak

import { currentVrm, currentTrainingMode, isGameRunning, currentDifficulty,
         DIFFICULTY_CONFIG, poseQueue, isTutorialLocked, triggerResult, world } from './app.js';
import { TongueDirectionDetector } from './tongue_direction.js';
import { onFaceFrame } from './face_tracker.js';
// 使用 index.html 上載入的全域 tf(已升級為 TF 4.x);speech-commands 也共用這個版本
const tf = window.tf;

const MODEL_URL = "./web_model/model.json";

let detector = null;
let video;
let isDetecting = false;
let lastTime = performance.now();
// 兩張畫面的最大間隔(ms):切換分頁回來時避免計時器一次跳好幾秒
const MAX_DT = 250;

// 沿用原本平滑邏輯(讓下游判定零修改)
const SMOOTHING_FACTOR = 0.1;
let smoothedProbs = {
  'Neutral': 1.0,
  'tongueUp': 0.0,
  'tongueDown': 0.0,
  'tongueLeft': 0.0,
  'tongueRight': 0.0,
};
const GAME_TRIGGER_THRESHOLD = 0.2;

// 模組回傳的中文方向 → 專案內部既有名稱
const DIR_TO_INTERNAL = {
  '上': 'tongueUp',
  '下': 'tongueDown',
  '左': 'tongueLeft',
  '右': 'tongueRight',
};

let holdTime = 0;
let turnTimeLeft = 5000;
let lastTarget = "";

export async function initTongueMode() {
  console.log("正在載入 U-Net 舌頭分割模型(取代 Teachable Machine)...");
  try {
    detector = await new TongueDirectionDetector({
      tf,
      modelPath: MODEL_URL,
      openThresh: 0.06,    // 嘴開合門檻;< 此值視為閉嘴不偵測
      probThresh: 0.5,     // 模型機率二值化門檻
      inferEvery: 2,       // 每 N 幀推論一次(2 = 算力砍半)
    }).load();
    console.log("✅ 舌頭模型載入成功!");
  } catch (error) {
    console.error("❌ 模型載入失敗,請檢查 web_model/ 路徑與檔案:", error);
  }

  // 與原版相同:抓 id="video" 的影像元素(原版即如此,實際 DOM 由 app.js 處理)
  video = document.getElementById("video");
}

export function startTongueDetection() {
  if (isDetecting) return;
  isDetecting = true;
  lastTime = performance.now();
  onFaceFrame(handleFaceFrame); // 由共用的臉部偵測迴圈每張新畫面呼叫一次
}

export function stopTongueDetection() {
  lastTarget = "";
}

function checkTonguePoseMatch(targetPose, detectedAction, confidence, threshold) {
  if (confidence <= threshold) return false;
  const poseMap = {
    '⬆️': 'tongueUp',
    '⬇️': 'tongueDown',
    '⬅️': 'tongueLeft',
    '➡️': 'tongueRight'
  };
  return poseMap[targetPose] === detectedAction;
}

// results 來自共用的 MediaPipe FaceLandmarker,不再自己重跑一次偵測
function handleFaceFrame(results, now) {
  const dt = Math.min(now - lastTime, MAX_DT);
  lastTime = now;
  if (!isDetecting || currentTrainingMode !== 'tongue') return;

  if (detector && video) {
    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const landmarks = results.faceLandmarks[0];

      // ⭐ 核心改變:U-Net 直接告訴我們方向,不需要自己裁切嘴部、不用 TM
      const r = detector.detect(video, landmarks);
      // r.direction → '上' | '下' | '左' | '右' | null
      // r.mouthOpen → boolean(閉嘴時 direction 必為 null,且不會跑推論)
      // r.openRatio → number(內唇高/寬)

      // 把方向結果灌進原本的 smoothedProbs 結構(讓下游遊戲邏輯零修改)
      const internalName = (r.direction && DIR_TO_INTERNAL[r.direction]) || 'Neutral';
      const newProbs = { Neutral: 0, tongueUp: 0, tongueDown: 0, tongueLeft: 0, tongueRight: 0 };
      newProbs[internalName] = 1.0;
      for (const key in smoothedProbs) {
        smoothedProbs[key] = smoothedProbs[key] * (1 - SMOOTHING_FACTOR)
                           + (newProbs[key] || 0) * SMOOTHING_FACTOR;
      }

      let detected = "";
      let highestConfidentProb = 0;
      const directionalPoses = ['tongueUp', 'tongueDown', 'tongueLeft', 'tongueRight'];
      directionalPoses.forEach(poseName => {
        if (smoothedProbs[poseName] > highestConfidentProb) {
          highestConfidentProb = smoothedProbs[poseName];
          detected = poseName;
        }
      });

      // VRM 表情(完全沿用原版邏輯)
      if (currentVrm) {
        try {
          ['tongueOut', 'tongueUp', 'tongueDown', 'tongueLeft', 'tongueRight'].forEach(exp => {
            currentVrm.expressionManager.setValue(exp, 0);
          });
          if (highestConfidentProb > 0.4 && detected !== "") {
            currentVrm.expressionManager.setValue('tongueOut', 0.8);
            currentVrm.expressionManager.setValue(detected, 0.2);
          }
        } catch (e) {}
      }

      // 遊戲過關判定(完全沿用原版邏輯)
      if (isGameRunning && poseQueue.length > 0) {
        const targetPose = poseQueue[0];
        const conf = DIFFICULTY_CONFIG[currentDifficulty];

        const isMatched = checkTonguePoseMatch(targetPose, detected, highestConfidentProb, GAME_TRIGGER_THRESHOLD);
        const hintMessage = document.getElementById("hint-message");

        if (targetPose !== lastTarget) {
          lastTarget = targetPose;
          holdTime = 0;
          turnTimeLeft = 10000;
        }

        if (isTutorialLocked) {
          if (hintMessage) {
            hintMessage.innerText = "🔊 請先聽完語音指示喔!";
            hintMessage.style.color = "#8e44ad";
          }
          holdTime = 0;
          world.setProgress(0);
        } else {
          if (isMatched) {
            if (hintMessage) {
              hintMessage.innerText = "👍 舌頭方向正確!請保持住!";
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
            if (hintMessage) {
              hintMessage.innerText = highestConfidentProb > (GAME_TRIGGER_THRESHOLD - 0.2)
                ? `🤔 方向不太對喔!`
                : "👅 預備!請對著鏡頭伸出舌頭!";
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
  }
}
