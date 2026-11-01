/*
 * TongueDirectionDetector — 舌頭方向偵測 (ES Module 版)
 * 取代 Teachable Machine,用我們訓練好的 U-Net 分割模型。
 *
 * 使用:
 *   import * as tf from 'https://esm.sh/@tensorflow/tfjs@4';
 *   import { TongueDirectionDetector } from './tongue_direction.js';
 *   const det = await new TongueDirectionDetector({ tf, modelPath: './web_model/model.json' }).load();
 *   const r = det.detect(videoElement, faceLandmarks);  // r.direction: '上'|'下'|'左'|'右'|null
 */
const ROI_SIZE = 128;
const ROI_PAD  = 1.6;

// FACEMESH_LIPS 唇部 landmark 索引(40 點)
const LIP_INDICES = [
  0,  13, 14, 17, 37, 39, 40, 61, 78, 80,
  81, 82, 84, 87, 88, 91, 95, 146,178,181,
  185,191,267,269,270,291,308,310,311,312,
  314,317,318,321,324,375,402,405,409,415,
];
const INNER_TOP = 13, INNER_BOTTOM = 14, LIP_LEFT = 78, LIP_RIGHT = 308;
// 判斷方向用的「臉的座標軸」:兩眼外眼角連線 = 左右方向(頭歪一邊時跟著轉);
// 鼻子底部與下巴 = 臉的中線(舌頭推擠嘴唇時不會跟著移動,比用嘴唇外框算中心穩定)
const EYE_R_OUTER = 33, EYE_L_OUTER = 263, NOSE_BASE = 2, CHIN = 152;
const MOUTH_CORNER_R = 61, MOUTH_CORNER_L = 291;
// 質心退路的最低要求:舌頭面積至少佔 ROI 的 0.5%(過濾零星雜點)、偏離中心至少 0.25 個半嘴寬,太小或太靠中間就不猜方向
const MIN_TONGUE_PIXELS = Math.round(ROI_SIZE * ROI_SIZE * 0.005);
const MIN_CENTROID_OFFSET = 0.25;

export class TongueDirectionDetector {
  constructor(opts) {
    opts = opts || {};
    this.tf = opts.tf;
    if (!this.tf) throw new Error('TongueDirectionDetector: constructor 需提供 tf 參考');
    this.modelPath  = opts.modelPath  || 'web_model/model.json';
    this.openThresh = opts.openThresh != null ? opts.openThresh : 0.06;
    this.probThresh = opts.probThresh != null ? opts.probThresh : 0.5;
    this.inferEvery = opts.inferEvery != null ? opts.inferEvery : 2;

    this.seg = null;
    this._cachedSeg = null;
    this._framesSince = 0;

    this.roiCanvas = document.createElement('canvas');
    this.roiCanvas.width = ROI_SIZE;
    this.roiCanvas.height = ROI_SIZE;
    this.roiCtx = this.roiCanvas.getContext('2d', { willReadFrequently: true });
  }

  async load() {
    this.seg = await this.tf.loadLayersModel(this.modelPath);
    // 暖機
    this.tf.tidy(() => this.seg.predict(this.tf.zeros([1, ROI_SIZE, ROI_SIZE, 3])));
    return this;
  }

  /**
   * 每幀呼叫;若無臉/閉嘴會回傳 direction: null。
   * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement|ImageBitmap} image
   * @param {Array<{x:number, y:number}>} landmarks  — MediaPipe Face Mesh / FaceLandmarker 的 468 點
   * 方向是「玩家自己的」左右(玩家往自己的左邊伸 = '左'),用臉的座標軸計算,頭歪一邊也不會判錯。
   * @returns {{direction: '上'|'下'|'左'|'右'|null, mouthOpen: boolean, openRatio: number,
   *            method?: string, votes?: object, tongueArea?: number}}  method / votes / tongueArea 給除錯面板看
   */
  detect(image, landmarks) {
    if (!landmarks || landmarks.length < 468 || !image) {
      this._cachedSeg = null; this._framesSince = 0;
      return { direction: null, mouthOpen: false, openRatio: 0 };
    }

    // (1) 嘴巴開合
    const dyL = Math.abs(landmarks[INNER_TOP].y - landmarks[INNER_BOTTOM].y);
    const dxL = Math.abs(landmarks[LIP_LEFT].x - landmarks[LIP_RIGHT].x);
    const openRatio = dxL > 0 ? dyL / dxL : 0;
    const mouthOpen = openRatio > this.openThresh;
    if (!mouthOpen) {
      this._cachedSeg = null; this._framesSince = 0;
      return { direction: null, mouthOpen: false, openRatio };
    }
    if (!this.seg) return { direction: null, mouthOpen: true, openRatio };

    const w = image.videoWidth  || image.width  || image.naturalWidth;
    const h = image.videoHeight || image.height || image.naturalHeight;
    if (!w || !h) return { direction: null, mouthOpen: true, openRatio };

    // (2) 唇部 bbox
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < LIP_INDICES.length; i++) {
      const p = landmarks[LIP_INDICES[i]];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const lipCx = (minX + maxX) * 0.5 * w;
    const lipCy = (minY + maxY) * 0.5 * h;
    const lipW  = (maxX - minX) * w;
    const lipH  = (maxY - minY) * h;

    // (3) 正方形 ROI(訓練/推論共用同一規格)
    const s  = Math.min(Math.max(lipW, lipH) * ROI_PAD, w, h);
    const x0 = Math.max(0, Math.min(w - s, lipCx - s * 0.5));
    const y0 = Math.max(0, Math.min(h - s, lipCy - s * 0.5));
    this.roiCtx.drawImage(image, x0, y0, s, s, 0, 0, ROI_SIZE, ROI_SIZE);

    // (4) 模型推論(跳幀快取省算力)。快取時一起記住當時的 ROI 位置,
    //     沿用上一張的結果時才不會因為頭在動而對錯位置
    if (!this._cachedSeg || this._framesSince >= this.inferEvery - 1) {
      const data = this.tf.tidy(() => {
        const x = this.tf.browser.fromPixels(this.roiCanvas).toFloat().div(255).expandDims(0);
        return this.seg.predict(x).squeeze().dataSync();
      });
      this._cachedSeg = { data, x0, y0, s };
      this._framesSince = 0;
    } else {
      this._framesSince++;
    }
    const { data: seg, x0: sx0, y0: sy0, s: ss } = this._cachedSeg;
    const isTongue = (px, py) => {
      const u = Math.round((px - sx0) / ss * ROI_SIZE);
      const v = Math.round((py - sy0) / ss * ROI_SIZE);
      return u >= 0 && u < ROI_SIZE && v >= 0 && v < ROI_SIZE && seg[v * ROI_SIZE + u] > this.probThresh;
    };

    // (5) 臉的座標軸:ex 指向「玩家自己的左邊」,ey 指向下巴(頭歪一邊時一起轉)
    const P = i => ({ x: landmarks[i].x * w, y: landmarks[i].y * h });
    const eR = P(EYE_R_OUTER), eL = P(EYE_L_OUTER);
    let ex = { x: eL.x - eR.x, y: eL.y - eR.y };
    const eLen = Math.hypot(ex.x, ex.y) || 1;
    ex = { x: ex.x / eLen, y: ex.y / eLen };
    const ey = { x: -ex.y, y: ex.x };
    const dot = (p, a) => p.x * a.x + p.y * a.y;
    // 中心:左右用臉的中線(鼻底與下巴),上下用嘴唇外框的中心
    const nose = P(NOSE_BASE), chin = P(CHIN);
    const cX = (dot(nose, ex) + dot(chin, ex)) / 2;
    const cY = dot({ x: lipCx, y: lipCy }, ey);
    // 正規化:半個嘴寬 / 半個嘴高(沿臉的座標軸量)
    const halfW = Math.max(1, Math.abs(dot(P(MOUTH_CORNER_L), ex) - dot(P(MOUTH_CORNER_R), ex)) * 0.5);
    let yMin = Infinity, yMax = -Infinity;
    for (const i of LIP_INDICES) { const y = dot(P(i), ey); if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
    const halfH = Math.max(1, (yMax - yMin) * 0.5);
    const faceXY = (px, py) => ({ nx: (dot({ x: px, y: py }, ex) - cX) / halfW, ny: (dot({ x: px, y: py }, ey) - cY) / halfH });
    const toDir = (nx, ny) => Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? '左' : '右') : (ny > 0 ? '下' : '上');

    // (6) Landmark 投票:被舌頭蓋住的嘴唇點在中心的哪一邊
    const votes = { '上': 0, '下': 0, '左': 0, '右': 0 };
    for (let i = 0; i < LIP_INDICES.length; i++) {
      const p = P(LIP_INDICES[i]);
      if (!isTongue(p.x, p.y)) continue;
      const { nx, ny } = faceXY(p.x, p.y);
      votes[toDir(nx, ny)]++;
    }
    const arr = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (arr[0][1] >= 2 && arr[0][1] > arr[1][1]) {
      return { direction: arr[0][0], mouthOpen: true, openRatio, method: '投票', votes };
    }

    // (7) 質心退路:舌頭整塊的中心在哪一邊(面積太小或太靠中間就不猜)
    let tsx = 0, tsy = 0, tn = 0;
    for (let v = 0; v < ROI_SIZE; v++) {
      const row = v * ROI_SIZE;
      for (let u = 0; u < ROI_SIZE; u++) {
        if (seg[row + u] > this.probThresh) { tsx += u; tsy += v; tn++; }
      }
    }
    if (tn < MIN_TONGUE_PIXELS) return { direction: null, mouthOpen: true, openRatio, method: '舌頭太小', votes, tongueArea: tn };
    const { nx, ny } = faceXY(sx0 + (tsx / tn) / ROI_SIZE * ss, sy0 + (tsy / tn) / ROI_SIZE * ss);
    if (Math.max(Math.abs(nx), Math.abs(ny)) < MIN_CENTROID_OFFSET) {
      return { direction: null, mouthOpen: true, openRatio, method: '舌頭在正中間', votes, tongueArea: tn, nx, ny };
    }
    return { direction: toDir(nx, ny), mouthOpen: true, openRatio, method: '質心', votes, tongueArea: tn, nx, ny };
  }

  dispose() {
    if (this.seg) this.seg.dispose();
    this.seg = null;
    this._cachedSeg = null;
  }
}
