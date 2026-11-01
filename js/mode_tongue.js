// js/mode_tongue.js
// === 用 U-Net 分割模型取代原本的 Teachable Machine 系統 ===
// ✦ export 介面與遊戲邏輯與原版 100% 相同,app.js 不用修改
// ✦ TF.js 4 透過 ESM CDN 動態載入,不影響 index.html 上既有的 tfjs@1.3.1(供 speech-commands 用)
// ✦ 原版備份在 mode_tongue.js.bak

import { currentVrm, currentTrainingMode, isGameRunning, currentDifficulty,
         DIFFICULTY_CONFIG, poseQueue, isTutorialLocked, triggerResult, world } from './app.js';
import { TongueDirectionDetector } from './tongue_direction.js';
import { onFaceFrame } from './face_tracker.js';
import { smoothToward, createMatchFilter } from './judge_utils.js';
import { debugShow } from './debug_panel.js';
// 使用 index.html 上載入的全域 tf(已升級為 TF 4.x);speech-commands 也共用這個版本
const tf = window.tf;

const MODEL_URL = "./web_model/model.json";

let detector = null;
let video;
let isDetecting = false;
let lastTime = performance.now();
// 兩張畫面的最大間隔(ms):切換分頁回來時避免計時器一次跳好幾秒
const MAX_DT = 250;

// 方向信心值的平滑:300ms 約等於以前「每秒 30 張、每張 10%」的反應速度,但不再受鏡頭張數影響
const SMOOTH_TAU = 300;
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
let wasMatched = false;                  // 上一刻是否做對(用來放寬門檻)
const matchFilter = createMatchFilter(250);

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

const INTERNAL_TO_ARROW = { tongueUp: '⬆️', tongueDown: '⬇️', tongueLeft: '⬅️', tongueRight: '➡️' };

// results 來自共用的 MediaPipe FaceLandmarker,不再自己重跑一次偵測
function handleFaceFrame(results, now) {
  const dt = Math.min(now - lastTime, MAX_DT);
  lastTime = now;
  if (!isDetecting || currentTrainingMode !== 'tongue' || !detector || !video) return;

  const hasFace = !!(results.faceLandmarks && results.faceLandmarks.length > 0);
  const r = hasFace ? detector.detect(video, results.faceLandmarks[0]) : null;
  // r.direction → '上' | '下' | '左' | '右' | null(玩家自己的左右)
  // r.mouthOpen → boolean(閉嘴時 direction 必為 null,且不會跑推論)

  if (r) {
    // 依實際經過時間平滑(以前是每張畫面固定 10%,鏡頭每秒張數不同時反應速度會差一倍)
    const internalName = (r.direction && DIR_TO_INTERNAL[r.direction]) || 'Neutral';
    for (const key in smoothedProbs) {
      smoothedProbs[key] = smoothToward(smoothedProbs[key], key === internalName ? 1 : 0, dt, SMOOTH_TAU);
    }
  }

  let detected = "";
  let highestConfidentProb = 0;
  ['tongueUp', 'tongueDown', 'tongueLeft', 'tongueRight'].forEach(poseName => {
    if (smoothedProbs[poseName] > highestConfidentProb) {
      highestConfidentProb = smoothedProbs[poseName];
      detected = poseName;
    }
  });

  // VRM 表情:人物的舌頭跟著玩家動(像照鏡子)
  if (currentVrm && r) {
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

  // 遊戲過關判定
  if (!isGameRunning || poseQueue.length === 0) return;
  const targetPose = poseQueue[0];
  const conf = DIFFICULTY_CONFIG[currentDifficulty];
  const hintMessage = document.getElementById("hint-message");
  const setHint = (text, color) => { if (hintMessage) { hintMessage.innerText = text; hintMessage.style.color = color; } };

  if (targetPose !== lastTarget) {
    lastTarget = targetPose;
    holdTime = 0;
    turnTimeLeft = 10000;
    wasMatched = false;
    matchFilter.reset();
  }

  // 找不到臉:暫停計時,不算玩家做錯
  if (!hasFace) {
    setHint("🙂 找不到臉,請把臉對準鏡頭", "#ffffff");
    debugShow('舌頭', { 目標: targetPose, 臉: '找不到' });
    return;
  }

  // 上一刻已經做對時門檻放寬一點,信心值在門檻附近抖動時不會一下對、一下錯
  const threshold = wasMatched ? GAME_TRIGGER_THRESHOLD * 0.75 : GAME_TRIGGER_THRESHOLD;
  const isMatched = checkTonguePoseMatch(targetPose, detected, highestConfidentProb, threshold);
  // 短暫閃掉(0.25 秒內)不算中斷:不累積、不扣時間,也不歸零
  const state = isTutorialLocked ? 'miss' : matchFilter.update(isMatched, now);
  wasMatched = state !== 'miss';

  debugShow('舌頭', {
    目標: targetPose,
    嘴巴張開: `${r.openRatio.toFixed(2)} / 門檻 ${detector.openThresh}`,
    // 往下的判斷依據:開口高寬比 ≥ 0.63 且舌頭佔開口 ≥ 25%
    開口高寬比: detector.lastShape && r.mouthOpen ? `${detector.lastShape.tall.toFixed(2)}${detector.lastShape.fill != null ? `,舌頭佔 ${Math.round(detector.lastShape.fill * 100)}%` : ''}` : '—',
    這張畫面: r.direction ? `${r.direction}(玩家自己的${r.direction}邊)` : '—',
    判斷方式: r.method || (r.mouthOpen ? '—' : '嘴巴沒張開'),
    票數: r.votes ? Object.entries(r.votes).map(([k, v]) => `${k}${v}`).join(' ') : '—',
    舌頭面積: r.tongueArea ?? '—',
    平滑後: detected ? `${INTERNAL_TO_ARROW[detected]} ${Math.round(highestConfidentProb * 100)}%(門檻 ${Math.round(threshold * 100)}%)` : '—',
    判定: { match: '✅ 做對', grace: '⏸ 短暫閃掉', miss: '❌ 沒做對' }[state],
    維持: `${Math.round(holdTime)} / ${conf.holdDuration} ms`,
  });

  if (isTutorialLocked) {
    setHint("🔊 請先聽完語音指示喔!", "#8e44ad");
    holdTime = 0;
    world.setProgress(0);
    return;
  }

  if (state === 'match') {
    setHint("👍 舌頭方向正確!請保持住!", "#f1c40f");
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

  if (!r.mouthOpen) {
    setHint("👅 預備!請張開嘴巴,伸出舌頭!", "#ffffff");
  } else if (detected && highestConfidentProb > GAME_TRIGGER_THRESHOLD) {
    setHint(`🤔 方向不太對喔!(偵測到: ${INTERNAL_TO_ARROW[detected]})`, "#ffffff"); // 顯示偵測到的方向,判反時一看就知道
  } else {
    setHint("👅 舌頭再伸出來一點!", "#ffffff");
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
