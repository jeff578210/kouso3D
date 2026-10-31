// js/world3d.js
// 左邊的 3D 世界:人物 + 森林小路場景 + 題目(泡泡 / 巨石)與過關特效。
// 遊戲邏輯(app.js 與各模式)只透過 createWorld() 回傳的介面告訴它「現在要顯示什麼」,
// 判定、計時、計分都不在這裡。
//
// 低階手機也要跑得動的做法:
// - 光影「烘焙」在頂點顏色上,全部用 MeshBasicMaterial(不做即時光照、不做即時陰影)
// - 同類景物合併成一個 Mesh:地形、林木、草地各只要 1 次繪製;描邊共用同一份幾何
// - 風吹、水流、花粉、描邊都在顯示卡的頂點/像素程式裡算,不佔 JavaScript 時間
// - 用霧讓遠景淡出;低畫質拿掉描邊、草地與蝴蝶,減少遠景樹木;解析度倍率上限 1.5,跑不順時自動降到 1
// - 音效用 Web Audio 即時合成(audio.js),不需要額外下載音檔
//
// 素材:KayKit Forest Nature Pack by Kay Lousberg (www.kaylousberg.com),CC0(授權檔在 assets3d/)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { playPop, playThud, playCrack } from './audio.js';

const SUN = new THREE.Vector3(0.45, 1, 0.55).normalize();
const SKY_TOP = '#5fbcec';
const SKY_HORIZON = '#e2f4f3';
const GRASS = '#a3d36c';
const OUTLINE_COLOR = '#3b3027'; // 接近人物描邊的深棕色,場景與人物風格一致

// 固定亂數種子:每次載入的景物位置都一樣
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const randRange = (a, b) => a + (b - a) * rand();
const pick = arr => arr[Math.floor(rand() * arr.length)];
const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// 依左邊 3D 畫面的比例決定構圖:人物維持正面特寫,旁邊留空間給題目
// (原本遊戲的鏡頭是 (0, 1.52, 0.8) 看著臉;這裡盡量維持臉的大小,只在旁邊挪出題目的位置)
// lane:題目飛進目標圈前最後一段的方向;stone / stoneR:發聲模式眼前那顆巨石的位置與半徑
const FRAMINGS = {
  wide:     { cam: [0, 1.50, 0.95], look: [0.22, 1.47, 0], ring: [0.36, 1.42, -0.05], lane: [0.6, 0.06, -0.8],  stone: [2.6, 1.0, -6],  stoneR: 1.0 },
  square:   { cam: [0, 1.50, 1.05], look: [0.08, 1.46, 0], ring: [0.21, 1.36, -0.05], lane: [0.15, 0.12, -1.0], stone: [1.3, 1.0, -6],  stoneR: 0.72 },
  portrait: { cam: [0, 1.46, 1.20], look: [0.00, 1.39, 0], ring: [0.07, 1.28, 0.16],  lane: [0.05, 0.2, -1.0],  stone: [0.06, 1.25, 0.17], stoneR: 0.055, scale: 0.72 },
};
const pickFraming = aspect => aspect >= 1.35 ? 'wide' : aspect >= 0.8 ? 'square' : 'portrait';

// ─────────────────────────────────────────────
// 幾何小工具
// ─────────────────────────────────────────────
function placed(geo, { x = 0, y = 0, z = 0, s = 1, sx = s, sy = s, sz = s, ry = 0, rx = 0 } = {}) {
  geo.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)),
    new THREE.Vector3(sx, sy, sz)));
  return geo;
}

// 只留下指定的頂點屬性,合併時才對得上
function keepAttributes(geo, names) {
  for (const k of Object.keys(geo.attributes)) if (!names.includes(k)) geo.deleteAttribute(k);
  return geo;
}

// 低多邊形烘焙(地形、遠山、橋用):每個面一個顏色,朝陽光的面亮、背光的面暗
function bakeFlat(geo, color, jitter = 0.05) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(color), c = new THREE.Color(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    n.fromBufferAttribute(nrm, i);
    c.copy(base).multiplyScalar((0.7 + 0.3 * Math.max(0, n.dot(SUN))) * (1 + (rand() - 0.5) * jitter));
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return keepAttributes(g, ['position', 'color']);
}

// 沿著曲線鋪一條貼地的帶子;uv.x = 橫向 0~1,uv.y = 沿線距離(公尺)
function ribbon(curve, width, y, { segments = 180, across = 1 } = {}) {
  const pos = [], uv = [];
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
  const len = curve.getLength();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, p = curve.getPointAt(t);
    side.crossVectors(curve.getTangentAt(t), up).normalize();
    for (let k = 0; k <= across; k++) {
      const a = k / across - 0.5;
      pos.push(p.x + side.x * a * width, y, p.z + side.z * a * width);
      uv.push(k / across, t * len);
    }
  }
  const idx = [], row = across + 1;
  for (let i = 0; i < segments; i++) for (let k = 0; k < across; k++) {
    const a = i * row + k, b = a + row;
    idx.push(a, a + 1, b, a + 1, b + 1, b); // 面朝上
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// 帶子依橫向位置上色:中間是 center 色,邊緣漸漸融入草地
function colorRibbon(geo, center, edge) {
  const uv = geo.attributes.uv, colors = new Float32Array(uv.count * 3);
  const a = new THREE.Color(center), b = new THREE.Color(edge), c = new THREE.Color();
  for (let i = 0; i < uv.count; i++) {
    c.copy(a).lerp(b, smooth(0.25, 0.5, Math.abs(uv.getX(i) - 0.5)));
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return keepAttributes(geo.toNonIndexed(), ['position', 'color']);
}

// ─────────────────────────────────────────────
// 地形配置:小路(題目路線底下)、河
// ─────────────────────────────────────────────
const ROAD = new THREE.CatmullRomCurve3([
  new THREE.Vector3(18, 0, -70), new THREE.Vector3(12, 0, -40), new THREE.Vector3(5, 0, -16),
  new THREE.Vector3(1.6, 0, -5), new THREE.Vector3(0.7, 0, 0.5),
]);
const RIVER = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-40, 0, -6), new THREE.Vector3(-14, 0, -7.5), new THREE.Vector3(-3, 0, -11),
  new THREE.Vector3(8, 0, -15), new THREE.Vector3(24, 0, -13), new THREE.Vector3(50, 0, -22),
]);
const ROAD_SAMPLES = Array.from({ length: 121 }, (_, i) => ROAD.getPointAt(i / 120));
const RIVER_SAMPLES = Array.from({ length: 121 }, (_, i) => RIVER.getPointAt(i / 120));
const distXZ = (samples, x, z) => samples.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.z - z)), Infinity);

function groundHeight(x, z) {
  const far = smooth(14, 55, Math.hypot(x, z));
  return (Math.sin(x * 0.09) * Math.cos(z * 0.07) + 0.6 * Math.sin((x + z) * 0.05)) * 2.2 * far;
}

function buildTerrain() {
  const parts = [];

  // 草地:平滑漸層 + 深淺草色斑塊(像手繪背景的筆觸)
  const ground = new THREE.PlaneGeometry(260, 260, 90, 90);
  ground.rotateX(-Math.PI / 2);
  const gp = ground.attributes.position;
  const gc = new Float32Array(gp.count * 3);
  const base = new THREE.Color(GRASS), dark = new THREE.Color('#86c25a'), light = new THREE.Color('#c0e488'), c = new THREE.Color();
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i);
    gp.setY(i, groundHeight(x, z) - 0.02);
    const patch = Math.sin(x * 0.21 + Math.sin(z * 0.13) * 2) * Math.cos(z * 0.17 + x * 0.05);
    c.copy(base).lerp(patch > 0 ? light : dark, Math.abs(patch) * 0.55);
    c.toArray(gc, i * 3);
  }
  ground.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  parts.push(keepAttributes(ground.toNonIndexed(), ['position', 'color']));

  // 小路與河岸:邊緣融入草地
  parts.push(colorRibbon(ribbon(ROAD, 2.6, 0.015, { across: 4 }), '#f0dfae', GRASS));
  parts.push(colorRibbon(ribbon(RIVER, 6.2, 0.012, { across: 4 }), '#eadcab', GRASS));

  // 木橋
  const bridgeAt = RIVER.getPointAt(0.31);
  for (let i = 0; i < 7; i++) {
    parts.push(bakeFlat(placed(new THREE.BoxGeometry(0.5, 0.12, 5.6), { x: bridgeAt.x - 1.5 + i * 0.5, y: 0.25, z: bridgeAt.z, ry: 0.15 }), '#c08a50'));
  }
  for (const dz of [-2.6, 2.6]) {
    parts.push(bakeFlat(placed(new THREE.BoxGeometry(3.6, 0.1, 0.12), { x: bridgeAt.x, y: 0.55, z: bridgeAt.z + dz, ry: 0.15 }), '#a87443'));
  }

  // 遠山:淡藍綠色,被霧自然淡化
  for (let i = 0; i < 9; i++) {
    parts.push(bakeFlat(placed(new THREE.ConeGeometry(randRange(16, 24), randRange(16, 28), 8), { x: -95 + i * 23 + randRange(-6, 6), y: 7, z: randRange(-110, -90), ry: rand() }), '#96c6b7', 0.06));
  }

  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ─────────────────────────────────────────────
// KayKit 模型:取出幾何、烘焙光影、加上擺動權重與描邊法線
// ─────────────────────────────────────────────
function loadModelLibrary(gltf) {
  const lib = {};
  gltf.scene.updateMatrixWorld(true);
  let atlas = null;
  for (const group of gltf.scene.children) {
    const geos = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      atlas ||= o.material.map;
      const g = o.geometry.clone();
      // glTF 的頂點資料是交錯排列的,合併前要拆成各自獨立的陣列
      for (const [k, a] of Object.entries(g.attributes)) if (a.isInterleavedBufferAttribute) g.setAttribute(k, a.clone());
      g.applyMatrix4(o.matrixWorld);
      geos.push(keepAttributes(g, ['position', 'normal', 'uv']));
    });
    const geo = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    geo.computeBoundingBox();
    lib[group.name] = geo;
  }
  return { lib, atlas };
}

// 放一個模型到世界中:套用位置/旋轉/縮放,把光影烘焙成頂點顏色,越高的地方隨風擺動越多。
// outline:另外算一組「平滑法線」給描邊用(稜角處的法線分岔會讓描邊裂開)
function bakeInstance(src, { x = 0, y = 0, z = 0, s = 1, ry = 0, sway = 0, outline = false }) {
  const g = src.clone();
  const bb = src.boundingBox, h = Math.max(1e-3, bb.max.y - bb.min.y);
  const pos = g.attributes.position, count = pos.count;
  const heightFrac = new Float32Array(count);
  for (let i = 0; i < count; i++) heightFrac[i] = (pos.getY(i) - bb.min.y) / h;

  placed(g, { x, y, z, s, ry });
  const nrm = g.attributes.normal, n = new THREE.Vector3();
  const colors = new Float32Array(count * 3), swayAttr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    n.fromBufferAttribute(nrm, i).normalize();
    const hf = heightFrac[i];
    // KayKit 的貼圖本身已是「上亮下暗」的漸層,這裡只補一點陽光方向感,避免雙重變暗
    const sun = Math.max(0, n.dot(SUN)), sky = 0.5 + 0.5 * n.y;
    const ao = 0.8 + 0.2 * smooth(0, 0.3, hf);               // 貼地處稍暗,物件看起來站在地上
    const l = (0.8 + 0.2 * sun + 0.08 * sky) * ao;
    colors[i * 3] = l * 1.03; colors[i * 3 + 1] = l; colors[i * 3 + 2] = l * 0.95; // 暖色陽光
    swayAttr[i] = sway * Math.pow(hf, 1.6);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('sway', new THREE.BufferAttribute(swayAttr, 1));

  if (outline) {
    const key = i => `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
    const sums = new Map();
    for (let i = 0; i < count; i++) {
      const k = key(i);
      if (!sums.has(k)) sums.set(k, new THREE.Vector3());
      sums.get(k).add(n.fromBufferAttribute(nrm, i));
    }
    const on = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) n.copy(sums.get(key(i))).normalize().toArray(on, i * 3);
    g.setAttribute('onormal', new THREE.BufferAttribute(on, 3));
  }
  return keepAttributes(g, outline ? ['position', 'uv', 'color', 'sway', 'onormal'] : ['position', 'uv', 'color', 'sway']);
}

// 風吹的頂點偏移:樹木與它的描邊共用同一段程式,兩者才會一起擺動
const WIND_GLSL = `
  float gust = sin(uTime * 0.7 + position.x * 0.05) * 0.5 + 0.5;
  float windW = sway * (sin(uTime * 1.7 + position.x * 0.35 + position.z * 0.27) * 0.65 + sin(uTime * 3.1 + position.z * 0.8) * 0.35) * (0.6 + 0.6 * gust);
  vec3 windOffset = vec3(windW * 0.16, 0.0, windW * 0.07);`;

function windMaterial(atlas, uTime, { doubleSide = false } = {}) {
  const m = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = shader => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = 'attribute float sway;\nuniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      ${WIND_GLSL}
      transformed += windOffset;`);
  };
  return m;
}

// 卡通描邊:畫物件的背面,沿法線往外推固定的「像素」寬度,遠近粗細一致(和人物的描邊同一種做法)
function outlineMaterial({ uTime, uRes, uWidth }) {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { color: { value: new THREE.Color(OUTLINE_COLOR) } }]),
    vertexShader: `
      attribute float sway;
      attribute vec3 onormal;
      uniform float uTime, uWidth;
      uniform vec2 uRes;
      #include <fog_pars_vertex>
      void main() {
        ${WIND_GLSL}
        vec4 mvPosition = modelViewMatrix * vec4(position + windOffset, 1.0);
        vec4 clip = projectionMatrix * mvPosition;
        vec2 dir = normalize((projectionMatrix * vec4(normalMatrix * onormal, 0.0)).xy + 1e-6);
        clip.xy += dir * uWidth * clip.w * 2.0 / uRes;
        gl_Position = clip;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 color;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(color, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }`,
  });
  Object.assign(m.uniforms, { uTime, uRes, uWidth });
  return m;
}

// 底下的柔和影子:一張放射漸層貼圖,所有影子合併成一個 Mesh
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(40,70,30,0.42)');
  g.addColorStop(0.6, 'rgba(40,70,30,0.2)');
  g.addColorStop(1, 'rgba(40,70,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildNature(lib, atlas, uniforms, quality) {
  const outlinedParts = [], plainParts = [], grassParts = [], shadows = [];
  const withOutline = quality !== 'low';
  const TREES_ROUND = ['Tree_1_A', 'Tree_1_B', 'Tree_2_A', 'Tree_2_B', 'Tree_2_C', 'Tree_3_A', 'Tree_3_B'];
  const PINES = ['Tree_4_A', 'Tree_4_B'];
  const BUSHES = ['Bush_1_B', 'Bush_1_D', 'Bush_2_B', 'Bush_2_D', 'Bush_3_A', 'Bush_3_B', 'Bush_4_B', 'Bush_4_D'];
  const ROCKS = ['Rock_1_A', 'Rock_1_D', 'Rock_2_B', 'Rock_2_C', 'Rock_3_A', 'Rock_3_G'];

  // near:近景與中景加描邊;遠景太小,描邊只會變成一團黑,不加
  const add = (name, o, near = true) => {
    const src = lib[name];
    if (!src) return;
    o.y = groundHeight(o.x, o.z) - 0.03;
    const outline = near && withOutline;
    (outline ? outlinedParts : plainParts).push(bakeInstance(src, { ...o, outline }));
    const bb = src.boundingBox;
    const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.55 * (o.s || 1);
    shadows.push(placed(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), { x: o.x + r * 0.15, y: o.y + 0.035, z: o.z - r * 0.1, sx: r * 2.4, sz: r * 2.1 }));
  };
  const clear = (x, z, { road = 3.2, river = 4.2 } = {}) =>
    !(Math.abs(x) < 3 && z > -5.5) && distXZ(ROAD_SAMPLES, x, z) > road && distXZ(RIVER_SAMPLES, x, z) > river;
  // 題目沿著小路上空飛來,路的兩側要留開闊的空間,泡泡才不會跟樹葉疊在一起
  const laneClear = (x, z) => z < -26 || distXZ(ROAD_SAMPLES, x, z) > 6.5;

  // 近景:人物左後方一小片樹林(構圖的主體)
  [['Tree_2_B', -4.6, -8.5, 1.0], ['Tree_1_B', -8.2, -11.5, 1.1], ['Tree_3_B', -2.8, -13.5, 0.95], ['Tree_2_C', -11.5, -7.5, 1.0],
   ['Tree_4_B', -6.2, -16, 1.0]].forEach(([n, x, z, s]) => add(n, { x, z, s, ry: rand() * 6.28, sway: 0.9 }));
  [['Bush_2_B', -2.4, -6.2, 1.0], ['Bush_1_D', -3.6, -6.8, 1.1], ['Bush_4_D', -6.4, -7.4, 1.0], ['Rock_1_D', -5.4, -9.6, 0.9],
   ['Bush_3_B', 7.0, -8.6, 1.0], ['Rock_2_C', 8.0, -10.2, 0.8], ['Bush_1_B', 6.2, -12.5, 1.2]].forEach(([n, x, z, s]) => add(n, { x, z, s, ry: rand() * 6.28, sway: 0.35 }));

  // 中景:路兩旁零星的樹、灌木、石頭
  const midTrees = quality === 'low' ? 14 : 26;
  for (let i = 0, tries = 0; i < midTrees && tries < 900; tries++) {
    const x = randRange(-26, 30), z = randRange(-34, -12);
    if (!clear(x, z) || !laneClear(x, z)) continue;
    add(rand() < 0.25 ? pick(PINES) : pick(TREES_ROUND), { x, z, s: randRange(0.85, 1.25), ry: rand() * 6.28, sway: 0.9 }); i++;
  }
  for (let i = 0, tries = 0; i < 34 && tries < 600; tries++) {
    const x = randRange(-16, 18), z = randRange(-26, -5);
    if (!clear(x, z, { road: 1.9, river: 3.4 }) || (x > 0 && !laneClear(x, z))) continue;
    add(rand() < 0.3 ? pick(ROCKS) : pick(BUSHES), { x, z, s: randRange(0.8, 1.3), ry: rand() * 6.28, sway: 0.35 }); i++;
  }

  // 遠景:一整排森林,讓地平線有層次
  const farTrees = quality === 'low' ? 18 : 46;
  for (let i = 0, tries = 0; i < farTrees && tries < 800; tries++) {
    const x = randRange(-60, 60), z = randRange(-62, -36);
    if (distXZ(ROAD_SAMPLES, x, z) < 4) continue;
    add(rand() < 0.4 ? pick(PINES) : pick(TREES_ROUND), { x, z, s: randRange(0.9, 1.5), ry: rand() * 6.28, sway: 0.6 }, false); i++;
  }
  [['Rock_3_M', 22, -46, 2.2], ['Rock_3_M', -30, -50, 2.6], ['Rock_3_G', -22, -44, 2.0]].forEach(([n, x, z, s]) => add(n, { x, z, s, ry: rand() * 6.28 }, false));

  const group = new THREE.Group();
  const fill = windMaterial(atlas, uniforms.uTime);
  const addMesh = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; group.add(m); return m; };
  if (outlinedParts.length) {
    const geo = mergeGeometries(outlinedParts);
    addMesh(geo, fill);
    addMesh(geo, outlineMaterial(uniforms)); // 描邊和本體共用同一份幾何,不多佔記憶體
  }
  if (plainParts.length) addMesh(mergeGeometries(plainParts), fill);

  // 草地:成片的小草叢,風吹時整片一起搖(低畫質不畫)
  // 從人物後方 4 公尺才開始長草,近處的草才不會比人物的臉還大
  if (quality !== 'low') {
    const GRASSES = ['Grass_1_A_Singlesided', 'Grass_1_B_Singlesided', 'Grass_2_A_Singlesided', 'Grass_2_B_Singlesided'];
    for (let i = 0, tries = 0; i < 650 && tries < 4000; tries++) {
      const x = randRange(-12, 14), z = randRange(-20, -4);
      if (distXZ(ROAD_SAMPLES, x, z) < 1.25 || distXZ(RIVER_SAMPLES, x, z) < 3.2) continue;
      grassParts.push(bakeInstance(lib[pick(GRASSES)], { x, y: groundHeight(x, z) - 0.02, z, s: randRange(0.35, 0.6), ry: rand() * 6.28, sway: 1.4 })); i++;
    }
    addMesh(mergeGeometries(grassParts), windMaterial(atlas, uniforms.uTime, { doubleSide: true }));
  }

  const shadowMesh = addMesh(mergeGeometries(shadows), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadowMesh.renderOrder = -1;
  return group;
}

// ─────────────────────────────────────────────
// 河水:漸層 + 流動的波光 + 岸邊白浪(全部在像素程式裡算)
// ─────────────────────────────────────────────
function buildWater(uTime) {
  const geo = ribbon(RIVER, 4.4, 0.03, { across: 6, segments: 220 });
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        float edge = min(vUv.x, 1.0 - vUv.x);
        vec3 shallow = vec3(0.60, 0.88, 0.93), deep = vec3(0.30, 0.70, 0.86);
        vec3 col = mix(shallow, deep, smoothstep(0.0, 0.4, edge));
        float flow = vUv.y * 0.9 - uTime * 1.2;
        float ripple = sin(flow * 2.3 + sin(vUv.x * 11.0 + vUv.y * 0.5) * 1.4) * sin(flow * 0.7 + vUv.x * 5.0);
        col += smoothstep(0.55, 0.95, ripple) * 0.22 * smoothstep(0.06, 0.25, edge);
        float foam = smoothstep(0.13, 0.02, edge + 0.035 * sin(vUv.y * 2.4 + uTime * 1.8));
        col = mix(col, vec3(1.0), foam * 0.9);
        gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.uniforms.uTime = uTime;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// 天空:由上往下的漸層 + 右上方的太陽光暈
function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(SKY_TOP) }, horizon: { value: new THREE.Color(SKY_HORIZON) }, sunDir: { value: new THREE.Vector3(0.55, 0.32, -0.77).normalize() } },
    vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 top, horizon, sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, top, smoothstep(-0.02, 0.5, d.y));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.93, 0.75) * (pow(s, 90.0) * 0.9 + pow(s, 9.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 32, 16), mat);
  sky.renderOrder = -2;
  return sky;
}

// 蓬鬆的雲:上面亮白、底部帶一點天空藍
function buildClouds() {
  const group = new THREE.Group();
  const top = new THREE.Color('#ffffff'), bottom = new THREE.Color('#cfe4f2');
  for (let i = 0; i < 6; i++) {
    const parts = [];
    for (let k = 0; k < 6; k++) {
      const g = placed(new THREE.IcosahedronGeometry(1, 2), { x: k * 1.3 - 3.2, y: Math.sin(k * 1.7) * 0.45, z: rand() * 0.8, s: randRange(1.1, 2.1), sy: randRange(0.7, 0.9) });
      const p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
      for (let v = 0; v < p.count; v++) { c.copy(bottom).lerp(top, smooth(-0.6, 0.9, p.getY(v))); c.toArray(col, v * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(keepAttributes(g, ['position', 'color']));
    }
    const cloud = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    cloud.position.set(randRange(-70, 70), randRange(16, 26), randRange(-95, -60));
    cloud.scale.setScalar(randRange(1.2, 2));
    cloud.userData.speed = randRange(0.25, 0.6);
    group.add(cloud);
  }
  return group;
}

// 漂浮的花粉:點雲,飄動在頂點程式裡算
function buildPollen(uTime, count) {
  const pos = new Float32Array(count * 3), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.set([randRange(-7, 9), randRange(0.4, 3.6), randRange(-12, -0.8)], i * 3);
    phase[i] = rand() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime, uScale: { value: 1 } },
    vertexShader: `
      attribute float phase; uniform float uTime, uScale; varying float vTwinkle;
      void main() {
        vec3 p = position + vec3(sin(uTime * 0.31 + phase) * 0.6, sin(uTime * 0.47 + phase * 1.3) * 0.35, cos(uTime * 0.27 + phase) * 0.5);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * 0.03 / -mv.z; // 花粉實際大小約 3 公分
        vTwinkle = 0.55 + 0.45 * sin(uTime * 2.0 + phase * 3.0);
      }`,
    fragmentShader: `
      varying float vTwinkle;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vTwinkle * 0.85;
        gl_FragColor = vec4(1.0, 0.97, 0.82, a);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

// 蝴蝶:兩片翅膀拍動,沿著平滑的路線飛舞
function wingTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(30, 22, 26, 18, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(24, 46, 16, 13, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.arc(34, 20, 6, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function buildButterflies(count) {
  const group = new THREE.Group();
  const colors = ['#ffd166', '#f6a5c0', '#ffffff', '#b8a4f0', '#ffb36b'];
  const wingGeo = new THREE.PlaneGeometry(0.14, 0.14).translate(0.07, 0, 0);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ map: wingTexture(colors[i % colors.length]), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const b = new THREE.Group();
    const left = new THREE.Mesh(wingGeo, mat), right = new THREE.Mesh(wingGeo, mat);
    right.scale.x = -1;
    b.add(left, right);
    b.userData = { left, right, cx: randRange(-5, 6), cz: randRange(-8, -2.5), cy: randRange(0.6, 2.2), ph: rand() * 10, r: randRange(0.8, 2) };
    group.add(b);
  }
  return group;
}

// ─────────────────────────────────────────────
// 文字貼圖(題目符號、血量、稱讚)
// ─────────────────────────────────────────────
const FONT = '"jf-openhuninn", "Microsoft JhengHei", sans-serif';
function textSprite(text, { color = '#ffffff', stroke = 'rgba(0,0,0,0.45)', badge = null, h = 128, w = 128, weight = 'bold', px = 88 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (badge) { ctx.fillStyle = badge; ctx.beginPath(); ctx.roundRect(2, 2, w - 4, h - 4, h / 2); ctx.fill(); }
  ctx.font = `${weight} ${px}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (stroke) { ctx.lineWidth = px * 0.12; ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(text, w / 2, h / 2 + px * 0.05); }
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + px * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(w / h, 1, 1);
  sprite.renderOrder = 2;
  return sprite;
}

// ─────────────────────────────────────────────
// 題目泡泡(嘴型 ㄚㄧㄨ / 舌頭 ⬆⬇⬅➡)
// ─────────────────────────────────────────────
const BUBBLE_R = 0.05;
const bubbleGeo = new THREE.SphereGeometry(1, 24, 16);
const shineGeo = new THREE.SphereGeometry(1, 10, 8);

function makeBubble(symbol) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(bubbleGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }));
  const rim = new THREE.Mesh(bubbleGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, side: THREE.BackSide, depthWrite: false }));
  rim.scale.setScalar(1.08);
  const shine = new THREE.Mesh(shineGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
  shine.scale.setScalar(0.22); shine.position.set(-0.38, 0.42, 0.75);
  const labelGray = textSprite(symbol, { color: '#7f8c8d', stroke: 'rgba(255,255,255,0.9)' });
  const labelWhite = textSprite(symbol, { color: '#ffffff' });
  labelGray.scale.multiplyScalar(1.15); labelWhite.scale.multiplyScalar(1.2);
  g.add(rim, body, shine, labelGray, labelWhite);
  g.userData = { body, labelGray, labelWhite, symbol };
  setBubbleCurrent(g, false);
  g.scale.setScalar(BUBBLE_R);
  return g;
}
function setBubbleCurrent(b, current) {
  const { body, labelGray, labelWhite } = b.userData;
  body.material.color.set(current ? '#3498db' : '#ffffff');
  body.material.opacity = body.material.userData.base = current ? 0.92 : 0.6; // base:淡入淡出時的原本透明度
  labelGray.visible = !current;
  labelWhite.visible = current;
}

// ─────────────────────────────────────────────
// 主程式:建立 3D 世界,回傳給遊戲操作的介面
// ─────────────────────────────────────────────
const STONE_MODEL = 'Rock_2_C';            // 塊狀石頭,呼應原本 2D 版的圓角方石
const STONE_R = 0.55;                      // 排隊中的石頭大小
const STONE_QUEUE_U = [0.8, 0.66, 0.5];    // 排隊中的石頭在小路上的位置
const SLOT_METERS = [0, 0.45, 1.0, 1.8, 2.9, 4.4]; // 題目泡泡距離目標圈幾公尺,集中在眼前看得到的地方
const WARNING_RED = new THREE.Color('#e74c3c');
const BUBBLE_BLUE = new THREE.Color('#3498db');
const HOLD_GREEN = new THREE.Color('#2ecc71');
const RING_WHITE = new THREE.Color('#ffffff');
const RING_FLASH = new THREE.Color('#ffe066');
const displaySymbol = s => s.replace(/️/g, ''); // ⬆️ → ⬆:畫成文字,不要畫成彩色表情符號

// 出現/消失時整組一起淡入淡出(記住每個材質原本的透明度)
function applyFade(obj, a) {
  obj.traverse(o => {
    const m = o.material;
    if (!m || !m.transparent) return;
    m.userData.base ??= m.opacity;
    m.opacity = m.userData.base * a;
  });
}

// 移除物件時釋放材質;文字貼圖是各自的,一起釋放(模型共用的貼圖與幾何不能釋放)
function disposeObject(obj) {
  obj.removeFromParent();
  obj.traverse(o => {
    if (!o.material) return;
    if (o.isSprite) o.material.map?.dispose();
    o.material.dispose();
  });
}

// quality:'high' | 'low'。onVrmLoaded(vrm):人物載入完成時呼叫
export async function createWorld(container, { quality = 'high', onVrmLoaded } = {}) {
  document.fonts?.load(`bold 88px ${FONT}`).catch(() => {}); // 題目字體先下載,開始出題時才用得到

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(SKY_HORIZON, 22, 105);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // 人物燈光維持原本遊戲的設定,人物看起來跟以前一樣(場景全部不吃燈光)
  const light = new THREE.DirectionalLight(0xffffff, 0.4);
  light.position.set(1, 1, 1).normalize();
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.3));

  const uTime = { value: 0 };
  const uniforms = { uTime, uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: 1.5 } };

  // 景物素材載入失敗時只會少了樹木與石頭,遊戲照常進行
  let lib = null, atlas = null;
  try {
    ({ lib, atlas } = loadModelLibrary(await new GLTFLoader().loadAsync('./assets3d/kaykit-nature.glb')));
  } catch (err) {
    console.warn('⚠️ 場景素材載入失敗,改用簡化場景:', err);
  }

  scene.add(buildSky(), buildTerrain(), buildWater(uTime));
  if (lib) scene.add(buildNature(lib, atlas, uniforms, quality));
  const clouds = buildClouds();
  const pollen = buildPollen(uTime, quality === 'low' ? 60 : 160);
  const butterflies = buildButterflies(quality === 'low' ? 0 : 5);
  scene.add(clouds, pollen, butterflies);

  // 人物腳下的柔和影子
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  blob.position.y = 0.04;
  scene.add(blob);

  // 人物
  let vrm = null;
  new GLTFLoader().register(p => new VRMLoaderPlugin(p)).load('./vrm/VRMWithTongue.vrm', gltf => {
    vrm = gltf.userData.vrm;
    scene.add(vrm.scene);
    vrm.humanoid.getNormalizedBoneNode('leftUpperArm').rotation.z = -1.1;
    vrm.humanoid.getNormalizedBoneNode('rightUpperArm').rotation.z = 1.1;
    onVrmLoaded?.(vrm);
  }, undefined, err => console.error('❌ 人物模型載入失敗:', err));

  // 目標圈:外圈慢慢旋轉;內側的綠色進度弧顯示「維持」了多久(取代 2D 版由下往上填滿)
  const ring = new THREE.Group();
  const spinner = new THREE.Group();
  const ringMain = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.006, 8, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95 }));
  const ringGlow = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.016, 8, 48), new THREE.MeshBasicMaterial({ color: '#fff6b0', transparent: true, opacity: 0.35, depthWrite: false }));
  spinner.add(ringGlow, ringMain);
  const arcMat = new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide,
    uniforms: { uProgress: { value: 0 }, color: { value: HOLD_GREEN.clone() } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uProgress; uniform vec3 color; varying vec2 vUv;
      void main() { if (vUv.x > uProgress) discard; gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
      }`,
  });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.01, 8, 72), arcMat);
  arc.rotation.z = Math.PI / 2; arc.scale.x = -1; // 從正上方開始、順時針增加
  ring.add(spinner, arc);
  scene.add(ring);

  // 題目飛過來的路線:沿著小路上空,一路飄到目標圈
  let flight = null;
  const trail = new THREE.Group();
  scene.add(trail);
  ring.visible = trail.visible = false; // 首頁不顯示,開始嘴型/舌頭遊戲時才出現(setMode)
  function buildFlight(ringPos, lane) {
    flight = new THREE.CatmullRomCurve3([
      new THREE.Vector3(18, 5, -70), new THREE.Vector3(12, 4, -40), new THREE.Vector3(5, 2.6, -16),
      new THREE.Vector3(1.6, 1.8, -5), ringPos.clone().add(new THREE.Vector3(...lane)), ringPos.clone(),
    ]);
    trail.children.forEach(disposeObject);
    const dots = [];
    for (let i = 0; i < 90; i++) {
      const u = 0.3 + 0.7 * (i / 90);
      const p = flight.getPointAt(u);
      dots.push(placed(new THREE.SphereGeometry(0.012 + 0.05 * (1 - u), 6, 4), { x: p.x, y: p.y, z: p.z }));
    }
    trail.add(new THREE.Mesh(mergeGeometries(dots), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false })));
  }
  let SLOTS = [];
  const computeSlots = () => { const L = flight.getLength(); SLOTS = SLOT_METERS.map(d => 1 - d / L); };

  // ── 鏡頭:依畫面比例選構圖;開場從高處俯瞰山谷飛到人物面前;巨石碎裂時輕微震動 ──
  let framing = null;
  let bubbleR = BUBBLE_R; // 依構圖調整題目大小(手機直式較小)
  const camBase = new THREE.Vector3(), camLook = new THREE.Vector3();
  // 開場:載入期間停在空拍位置,玩家可以開始玩時(playIntro)才飛進來;系統設定「減少動態效果」時直接跳過
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const intro = { state: reduceMotion ? 'done' : 'waiting', t: 0, dur: 3.8, speed: 1,
    from: new THREE.Vector3(-5, 6.5, 10), fromLook: new THREE.Vector3(4, 0.5, -24) };
  let shakeT = 0;
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h); // 同時設定畫布的 CSS 尺寸,高解析度螢幕才不會被放大裁切
    const pr = renderer.getPixelRatio();
    uniforms.uRes.value.set(w * pr, h * pr);
    uniforms.uWidth.value = 1.3 * pr; // 描邊約 1.3 個 CSS 像素寬,和人物描邊接近
    // 每公尺在距離 1 公尺處對應的像素數,讓花粉依實際大小與距離縮放
    pollen.material.uniforms.uScale.value = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const f = FRAMINGS[pickFraming(camera.aspect)];
    if (f !== framing) {
      framing = f;
      camBase.set(...f.cam);
      camLook.set(...f.look);
      ring.position.set(...f.ring);
      ring.scale.setScalar(f.scale ?? 1);
      bubbleR = BUBBLE_R * (f.scale ?? 1);
      buildFlight(ring.position, f.lane);
      computeSlots();
    }
  }
  new ResizeObserver(resize).observe(container);
  window.addEventListener('orientationchange', () => setTimeout(resize, 300)); // 部分手機旋轉後尺寸會晚一點才更新
  resize();

  const camPos = new THREE.Vector3(), lookAt = new THREE.Vector3();
  function updateCamera(dt) {
    camPos.copy(camBase); lookAt.copy(camLook);
    if (intro.state === 'waiting') {
      camPos.copy(intro.from); lookAt.copy(intro.fromLook);
    } else if (intro.state === 'playing') {
      intro.t += dt * intro.speed;
      const k = Math.min(1, intro.t / intro.dur);
      const kPos = easeInOut(k), kLook = easeInOut(Math.min(1, k * 1.15)); // 視線比位置早一點轉向人物
      camPos.lerpVectors(intro.from, camBase, kPos);
      camPos.y += Math.sin(kPos * Math.PI) * 0.8; // 飛行路線微微拱起
      lookAt.lerpVectors(intro.fromLook, camLook, kLook);
      if (k >= 1) intro.state = 'done';
    }
    if (shakeT > 0) {
      shakeT -= dt;
      const a = 0.006 * Math.max(0, shakeT / 0.3);
      camPos.x += (rand() - 0.5) * a; camPos.y += (rand() - 0.5) * a;
    }
    camera.position.copy(camPos);
    camera.lookAt(lookAt);
  }
  // 開場還沒飛完就開始遊戲:剩下的路程在 0.8 秒內飛完
  function hurryIntro() {
    if (intro.state === 'waiting') intro.state = 'playing';
    if (intro.state === 'playing') intro.speed = Math.max(1, (intro.dur - intro.t) / 0.8);
  }

  // ── 特效:彩色紙屑、稱讚字樣、塵土 ──
  const effects = [];
  const spawn = (obj, life, step) => { if (!obj.parent) scene.add(obj); effects.push({ obj, life, max: life, step }); };
  const CONFETTI = ['#ff6b6b', '#ffd93d', '#6bcB77', '#4d96ff', '#c77dff', '#ff9f43'];
  const confettiGeo = new THREE.PlaneGeometry(1, 1.6);
  function burstConfetti(at, size) {
    const n = quality === 'low' ? 8 : 18;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(confettiGeo, new THREE.MeshBasicMaterial({ color: CONFETTI[i % CONFETTI.length], side: THREE.DoubleSide, transparent: true, depthWrite: false }));
      m.scale.setScalar(size * (0.32 + rand() * 0.2));
      m.position.copy(at);
      const v = new THREE.Vector3(rand() - 0.5, 0.4 + rand() * 0.8, (rand() - 0.5) * 0.6).normalize().multiplyScalar(size * (9 + rand() * 7));
      const spin = new THREE.Vector3(rand(), rand(), rand()).multiplyScalar(12);
      spawn(m, 0.9, (dt, k) => {
        v.y -= size * 22 * dt;
        m.position.addScaledVector(v, dt);
        m.rotation.x += spin.x * dt; m.rotation.y += spin.y * dt; m.rotation.z += spin.z * dt;
        m.material.opacity = Math.min(1, (1 - k) * 3);
      });
    }
  }
  function praise(at, size) {
    const s = textSprite(pick(['很棒!', '好厲害!', '完美!', '太好了!']), { px: 76, w: 320, h: 112, color: '#fff3a3', stroke: 'rgba(230,126,34,0.95)' });
    s.position.copy(at).add(new THREE.Vector3(0, size * 1.6, size * 0.5));
    const y0 = s.position.y;
    spawn(s, 0.9, (dt, k) => {
      s.position.y = y0 + size * 1.2 * easeInOut(k);
      s.material.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      s.scale.setScalar(size * 1.5 * (k < 0.15 ? 0.6 + k / 0.15 * 0.4 : 1)).multiply(new THREE.Vector3(320 / 112, 1, 1));
    });
  }
  const dustGeo = new THREE.SphereGeometry(1, 10, 8);
  function dust(at, r, count) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(dustGeo, new THREE.MeshBasicMaterial({ color: '#d9d2c3', transparent: true, depthWrite: false }));
      const dir = new THREE.Vector3(rand() - 0.5, rand() * 0.6, rand() - 0.2).normalize();
      m.position.copy(at).addScaledVector(dir, r * 0.7);
      const grow = r * (0.18 + rand() * 0.15);
      spawn(m, 0.7, (dt, k) => {
        m.position.addScaledVector(dir, r * 0.9 * dt);
        m.scale.setScalar(grow * (0.5 + k));
        m.material.opacity = 0.6 * (1 - k);
      });
    }
  }

  // ── 巨石:眼前路上一顆大石塊(有描邊),後面排隊的石頭沿小路滾過來 ──
  // 把石頭正規化成「半徑 1、中心在原點」,方便依構圖縮放
  const normalize = g => {
    g.computeBoundingBox();
    const bb = g.boundingBox, c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    const k = 2 / Math.max(size.x, size.y, size.z);
    return g.translate(-c.x, -c.y, -c.z).scale(k, k, k);
  };
  // 素材沒載入時改用簡單的多面體石頭
  const rockUnit = normalize(lib ? bakeInstance(lib[STONE_MODEL], { outline: true }) : bakeFlat(new THREE.IcosahedronGeometry(1, 0), '#9aa3a8'));
  const shardGeo = normalize(lib ? bakeInstance(lib.Rock_1_A, {}) : bakeFlat(new THREE.IcosahedronGeometry(1, 0), '#8d969b'));
  const stoneOutlineMat = lib && quality !== 'low' ? outlineMaterial(uniforms) : null;

  function makeStone(syllable) {
    const g = new THREE.Group();
    const body = new THREE.Group(); // 滾動時只轉石頭本體,字和血量維持正面
    const rock = new THREE.Mesh(rockUnit, new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true }));
    body.add(rock);
    if (stoneOutlineMat) body.add(new THREE.Mesh(rockUnit, stoneOutlineMat));
    const label = textSprite(syllable, { px: 80, w: 192, h: 128, stroke: 'rgba(0,0,0,0.85)' });
    label.position.set(0, 0.1, 1.05); label.scale.multiplyScalar(0.75);
    g.add(body, label);
    g.userData = { symbol: syllable, body, rock, label, hp: null, hpKey: '', shake: 0, appear: 1 };
    return g;
  }
  function setStoneHp(stone, text, warn) {
    const d = stone.userData;
    if (d.hpKey === `${text}|${warn}`) return; // 倒數每秒才變一次,沒變就不重畫文字
    d.hpKey = `${text}|${warn}`;
    if (d.hp) disposeObject(d.hp);
    d.hp = null;
    if (!text) return;
    const hp = textSprite(text, { px: 40, w: 384, h: 72, stroke: null, badge: warn ? 'rgba(231,76,60,0.92)' : 'rgba(0,0,0,0.62)' });
    hp.position.set(0, 1.18, 0.3); hp.scale.multiplyScalar(0.36); // 放在石頭上方,不會被底部按鈕蓋住
    stone.add(hp);
    d.hp = hp;
  }
  // 第 i 顆石頭該在的位置與大小:第 0 顆在眼前,其他沿小路排隊
  const stoneTarget = new THREE.Vector3();
  function stoneSlot(i) {
    if (i === 0) { stoneTarget.set(...framing.stone); return framing.stoneR; }
    const p = ROAD.getPointAt(STONE_QUEUE_U[i - 1] ?? 0.35); // 排不下的在更遠處等
    stoneTarget.set(p.x, STONE_R * 0.9, p.z);
    return STONE_R;
  }

  function explodeStone(stone) {
    const at = stone.position, r = stone.scale.x; // 碎片大小、飛散距離跟著石頭大小
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, transparent: true }));
      s.scale.setScalar((0.18 + rand() * 0.22) * r);
      s.position.copy(at).add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.5 * r));
      const v = new THREE.Vector3(rand() - 0.5, 0.6 + rand(), rand() - 0.2).normalize().multiplyScalar((2 + rand() * 2.5) * r);
      const spin = new THREE.Vector3(rand(), rand(), rand()).multiplyScalar(8);
      spawn(s, 1.1, (dt, k) => {
        v.y -= 9.8 * r * dt;
        s.position.addScaledVector(v, dt);
        s.rotation.x += spin.x * dt; s.rotation.y += spin.y * dt;
        s.material.opacity = Math.min(1, (1 - k) * 2.2);
      });
    }
    dust(at, r, quality === 'low' ? 5 : 10);
    burstConfetti(at, r * 0.35);
    shakeT = 0.3;
  }

  // ── 題目:畫面上的泡泡或石頭,items[0] 是目前這一題 ──
  let mode = null;          // 'mouth' | 'tongue' | 'voice' | null(首頁)
  const items = [];
  let progress = 0;         // 目前這題維持了多少(0~1)
  let warning = false;      // 快沒時間了
  let locked = false;       // 新手教學:聽完語音指示前不能動作
  const lockSprite = textSprite('🚫', { stroke: null });
  lockSprite.visible = false;
  lockSprite.renderOrder = 3;
  scene.add(lockSprite);

  const isStoneMode = () => mode === 'voice';
  function clearItems() {
    items.splice(0).forEach(dismiss);
    progress = 0; warning = false; locked = false;
  }
  function spawnItem(symbol, i) {
    let it;
    if (isStoneMode()) {
      it = makeStone(symbol);
      stoneSlot(i + 1); // 從後面一格滾進來
      it.position.copy(stoneTarget);
      it.scale.setScalar(STONE_R);
    } else {
      it = makeBubble(displaySymbol(symbol));
      it.userData.symbol = symbol;
      it.userData.u = Math.max(0, SLOTS[i] - 0.12); // 從小路遠方飄進來
      it.userData.appear = 0;
    }
    scene.add(it);
    return it;
  }
  // 換掉的題目:淡出後移除
  function dismiss(it) {
    const s0 = it.scale.x;
    spawn(it, 0.25, (dt, k) => { it.scale.setScalar(s0 * (1 - k)); applyFade(it, 1 - k); });
  }

  function setBubbleLook(b, i) {
    const { body } = b.userData;
    if (i !== 0) return;
    // 目前這題:藍色,維持越久越綠;快沒時間時紅色閃爍
    body.material.color.copy(BUBBLE_BLUE).lerp(HOLD_GREEN, progress);
    if (warning) body.material.color.lerp(WARNING_RED, 0.5 + 0.5 * Math.sin(t * 7));
  }

  const prevPos = new THREE.Vector3();
  function updateItems(dt) {
    const follow = 1 - Math.exp(-dt * 7);
    if (isStoneMode()) {
      items.forEach((s, i) => {
        const d = s.userData;
        const r = stoneSlot(i);
        prevPos.copy(s.position);
        s.position.lerp(stoneTarget, 1 - Math.exp(-dt * 4));
        const scale = s.scale.x + (r - s.scale.x) * (1 - Math.exp(-dt * 4));
        s.scale.setScalar(scale);
        d.body.rotation.x += prevPos.distanceTo(s.position) / Math.max(scale, 0.05); // 沿路朝鏡頭滾過來
        // 快到定點時轉回正面朝上,石角才不會擋住題目字和倒數
        if (s.position.distanceTo(stoneTarget) < 0.1 * r) {
          const upright = Math.round(d.body.rotation.x / (Math.PI * 2)) * Math.PI * 2;
          d.body.rotation.x += (upright - d.body.rotation.x) * follow;
        }
        // 被敲:左右震動 + 閃一下
        d.shake = Math.max(0, d.shake - dt / 0.25);
        s.position.x += Math.sin(t * 60) * 0.09 * scale * d.shake;
        d.rock.material.color.setScalar(1.15 + 0.5 * d.shake);
        if (d.hp) d.hp.visible = i === 0;
      });
    } else {
      items.forEach((b, i) => {
        const d = b.userData;
        d.u += (SLOTS[i] - d.u) * follow;
        b.position.copy(flight.getPointAt(THREE.MathUtils.clamp(d.u, 0, 1)));
        b.position.y += Math.sin(t * 2 + i) * 0.004 * i; // 排隊的泡泡輕輕上下飄
        d.appear = Math.min(1, d.appear + dt / 0.3);
        let s = bubbleR * (i === 0 ? 1.12 : 1) * (0.6 + 0.4 * d.appear);
        if (i === 0 && progress > 0) s *= 1.03 + 0.03 * Math.sin(t * 10); // 正在維持:輕輕脈動
        b.scale.setScalar(s);
        applyFade(b, d.appear);
        setBubbleLook(b, i);
      });
    }

    // 教學鎖定的 🚫 蓋在目前這題前面
    const cur = items[0];
    lockSprite.visible = locked && !!cur;
    if (lockSprite.visible) {
      const r = cur.scale.x;
      lockSprite.position.copy(cur.position).add(new THREE.Vector3(0, 0, r * 1.2));
      lockSprite.scale.setScalar(r * (isStoneMode() ? 1.3 : 1.8));
    }

    // 目標圈:維持進度弧、快沒時間時變紅、過關時閃一下
    arcMat.uniforms.uProgress.value = progress;
    const flash = ring.userData.flash || 0;
    ring.userData.flash = Math.max(0, flash - dt * 3);
    spinner.scale.setScalar(1 + flash * 0.35);
    ringMain.material.color.copy(RING_WHITE).lerp(RING_FLASH, flash);
    if (warning) ringMain.material.color.lerp(WARNING_RED, 0.5 + 0.5 * Math.sin(t * 7));
    ringGlow.material.opacity = 0.25 + 0.2 * Math.sin(t * 4);
    spinner.rotation.z = t * 0.6;
  }

  // ── 動畫迴圈 ──
  const clock = new THREE.Clock();
  let t = 0, blink = 0, nextBlink = 2.5;
  let frames = 0, fpsT = 0, slowWindows = 0, lastFps = 0;

  function update(dt) {
    t += dt;
    uTime.value = t;
    updateCamera(dt);

    clouds.children.forEach(c => { c.position.x += c.userData.speed * dt; if (c.position.x > 90) c.position.x = -90; });
    butterflies.children.forEach(b => {
      const u = b.userData, k = t * 0.5 + u.ph;
      b.position.set(u.cx + Math.sin(k) * u.r, u.cy + Math.sin(k * 2.3) * 0.25, u.cz + Math.sin(k * 0.8) * Math.cos(k * 1.3) * u.r * 0.6);
      b.rotation.y = Math.atan2(Math.cos(k), -Math.sin(k * 0.8));
      const flap = Math.sin(t * 18 + u.ph) * 1.1;
      u.left.rotation.y = flap; u.right.rotation.y = -flap;
    });
    updateItems(dt);

    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.life -= dt;
      e.step(dt, 1 - Math.max(0, e.life) / e.max);
      if (e.life <= 0) { disposeObject(e.obj); effects.splice(i, 1); }
    }

    if (vrm) {
      // 眨眼 + 輕微呼吸;嘴型、舌頭、頭部轉動由臉部追蹤控制
      blink += dt;
      let bv = 0;
      if (blink > nextBlink) { const p = blink - nextBlink; bv = p < 0.1 ? p / 0.1 : p < 0.2 ? 1 - (p - 0.1) / 0.1 : 0; if (p >= 0.2) { blink = 0; nextBlink = 2 + Math.random() * 3; } }
      vrm.expressionManager.setValue('blinkLeft', bv);
      vrm.expressionManager.setValue('blinkRight', bv);
      vrm.expressionManager.setValue('blink', bv);
      const chest = vrm.humanoid.getNormalizedBoneNode('chest');
      if (chest) chest.rotation.x = Math.sin(t * 1.6) * 0.015;
      vrm.update(dt);
    }
  }

  // 畫面一直跑不順(和臉部辨識搶顯示卡)時,自動把解析度倍率降到 1
  function adaptQuality(rawDt) {
    frames++; fpsT += rawDt;
    if (fpsT < 2) return;
    lastFps = Math.round(frames / fpsT);
    frames = 0; fpsT = 0;
    if (document.hidden || intro.state !== 'done' || renderer.getPixelRatio() <= 1) return;
    slowWindows = lastFps < 35 ? slowWindows + 1 : 0;
    if (slowWindows >= 2) {
      renderer.setPixelRatio(1);
      resize();
      console.info(`🖥️ 畫面每秒 ${lastFps} 張,解析度倍率降為 1`);
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    const rawDt = clock.getDelta();
    update(Math.min(rawDt, 0.1));
    renderer.render(scene, camera);
    adaptQuality(rawDt);
  }
  loop();

  return {
    // 開場鏡頭(玩家可以開始操作時呼叫一次)
    playIntro() { if (intro.state === 'waiting') intro.state = 'playing'; },

    // 進入遊戲('mouth' | 'tongue' | 'voice')或回到首頁(null):清掉畫面上的題目
    setMode(next) {
      mode = next;
      clearItems();
      ring.visible = trail.visible = mode === 'mouth' || mode === 'tongue';
      if (mode) hurryIntro();
    },

    // 讓畫面上的題目跟遊戲的題目佇列一致:前面相同的保留,從第一個不同的開始換掉
    setQueue(list) {
      if (!mode) return;
      const wanted = list.slice(0, isStoneMode() ? 1 + STONE_QUEUE_U.length : SLOT_METERS.length);
      let i = 0;
      while (i < items.length && i < wanted.length && items[i].userData.symbol === wanted[i]) i++;
      items.splice(i).forEach(dismiss);
      for (; i < wanted.length; i++) items.push(spawnItem(wanted[i], i));
      items.forEach((it, k) => { if (!isStoneMode()) setBubbleCurrent(it, k === 0); });
      progress = 0; warning = false;
    },

    setProgress(p) { progress = THREE.MathUtils.clamp(p, 0, 1); },
    setWarning(on) { warning = !!on; },
    setLocked(on) { locked = !!on; },

    // 目前這題結束:成功 → 泡泡破掉 + 紙屑 + 稱讚;失敗 → 泡泡變紅消散 / 石頭沉進地面
    resolve(success) {
      const cur = items.shift();
      progress = 0; warning = false; locked = false;
      if (!cur) return;
      if (cur.userData.broken) { disposeObject(cur); return; } // 石頭敲碎時已經播過特效
      const s0 = cur.scale.x;
      if (isStoneMode()) {
        dust(cur.position.clone().setY(cur.position.y - 0.6 * s0), s0 * 0.6, 6);
        spawn(cur, 0.5, (dt, k) => { cur.scale.setScalar(s0 * (1 - easeInOut(k))); cur.position.y -= s0 * 0.8 * dt; });
      } else if (success) {
        burstConfetti(cur.position, bubbleR);
        praise(ring.position, bubbleR);
        ring.userData.flash = 1;
        playPop();
        spawn(cur, 0.3, (dt, k) => { cur.scale.setScalar(s0 * (1 + k)); applyFade(cur, 1 - k); });
      } else {
        cur.userData.body.material.color.copy(WARNING_RED);
        spawn(cur, 0.3, (dt, k) => { cur.scale.setScalar(s0 * (1 - 0.2 * k)); applyFade(cur, 1 - k); });
      }
    },

    // 發聲模式:敲一下(震動 + 塵土 + 悶響)
    stoneHit() {
      const s = items[0];
      if (!s || !isStoneMode()) return;
      s.userData.shake = 1;
      const r = s.scale.x;
      dust(s.position.clone().add(new THREE.Vector3(0, -0.4 * r, 0.6 * r)), r * 0.5, 4);
      playThud();
    },
    // 發聲模式:敲碎(碎片 + 塵土 + 鏡頭震動 + 碎裂聲)。之後遊戲呼叫 resolve(true) 時只會把它移除
    stoneBreak() {
      const s = items[0];
      if (!s || !isStoneMode() || s.userData.broken) return;
      s.userData.broken = true;
      explodeStone(s);
      s.visible = false;
      playCrack();
    },
    // 發聲模式:石頭上方的剩餘次數 / 倒數(warn:剩 3 秒時變紅)
    setStoneLabel(text, warn = false) {
      if (items[0] && isStoneMode()) setStoneHp(items[0], text, warn);
    },

    // 除錯用:目前的效能數據
    info: () => ({ fps: lastFps, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
      pixelRatio: renderer.getPixelRatio(), framing: pickFraming(camera.aspect), quality,
      queue: items.map(it => it.userData.symbol), progress, warning, locked }),
  };
}
