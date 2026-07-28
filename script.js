/* ============================================
   工具函数：检测 reduced-motion 偏好
   ============================================ */

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================
   场景切换函数
   ============================================ */

function switchScene(sceneId) {
  document.querySelectorAll('.scene').forEach(s => s.classList.remove('active'));
  document.getElementById(sceneId).classList.add('active');

  if (sceneId === 'scene2') {
    initScene2();
  } else {
    destroyScene2();
  }
}

/* ============================================
   工具函数：显示提示气泡
   ============================================ */

let tooltipTimer = null;

function showTooltip(x, y) {
  const existing = document.querySelector('.tooltip-bubble');
  if (existing) existing.remove();
  if (tooltipTimer) clearTimeout(tooltipTimer);

  const bubble = document.createElement('div');
  bubble.className = 'tooltip-bubble';
  bubble.textContent = '不可以点这里哦~';

  bubble.style.left = x + 'px';
  bubble.style.top  = (y - 52) + 'px';
  bubble.style.transform = 'translate(-50%, 0)';

  document.body.appendChild(bubble);

  tooltipTimer = setTimeout(() => {
    if (bubble.parentNode) bubble.remove();
    tooltipTimer = null;
  }, 1500);
}

/* ============================================
   "不愿意" 按钮：逃跑逻辑
   ============================================ */

(function() {
  const btnNo = document.getElementById('btn-no');
  if (!btnNo) return;

  btnNo.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    showTooltip(e.clientX, e.clientY);
    return false;
  });

  function calcEscape(mouseX, mouseY, el) {
    const rect   = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = centerX - mouseX;
    const dy = centerY - mouseY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const runDist = 80 + Math.random() * 70;

    let offsetX = nx * runDist;
    let offsetY = ny * runDist;

    const predictedLeft = rect.left + offsetX;
    const predictedTop  = rect.top  + offsetY;
    const margin = 20;

    if (predictedLeft < margin ||
        predictedLeft + rect.width > window.innerWidth - margin ||
        predictedTop < margin ||
        predictedTop + rect.height > window.innerHeight - margin) {
      offsetX = -nx * runDist * 0.8;
      offsetY = -ny * runDist * 0.8;
    }
    return { x: offsetX, y: offsetY };
  }

  btnNo.addEventListener('mouseenter', function(e) {
    const offset = calcEscape(e.clientX, e.clientY, btnNo);
    btnNo.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  });

  btnNo.addEventListener('touchmove', function(e) {
    e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;
    const offset = calcEscape(touch.clientX, touch.clientY, btnNo);
    btnNo.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  }, { passive: false });

  btnNo.addEventListener('touchend', function() {
    btnNo.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    btnNo.style.transform = 'translate(0, 0)';
    setTimeout(() => btnNo.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)', 500);
  });

  btnNo.addEventListener('touchcancel', function() {
    btnNo.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    btnNo.style.transform = 'translate(0, 0)';
    setTimeout(() => btnNo.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)', 500);
  });
})();

/* ============================================
   "愿意" 按钮：信封打开 → 场景切换
   ============================================ */

(function() {
  const btnYes    = document.getElementById('btn-yes');
  const envelope  = document.querySelector('.envelope');
  if (!btnYes || !envelope) return;

  btnYes.addEventListener('click', function() {
    if (envelope.classList.contains('opening')) return;
    envelope.classList.add('opening');

    const delay = prefersReducedMotion ? 100 : 600;
    setTimeout(() => {
      switchScene('scene2');
      const scene2 = document.getElementById('scene2');
      if (scene2 && !prefersReducedMotion) {
        scene2.classList.add('animate__animated', 'animate__fadeIn');
      }
      envelope.classList.remove('opening');
    }, delay);
  });
})();

/* ============================================
   场景2 — Three.js 粒子圣诞树 + 手势 + 音频
   ============================================ */

// ---- 手势阈值 ----
const OPEN_THRESHOLD  = 0.25;   // 指尖到手腕 > 此值 → 五指张开
const CLOSED_THRESHOLD = 0.15;  // 指尖到手腕 < 此值 → 握拳

// ---- 全局状态 ----
let scene2Data      = null;
let scene2Phase     = 'tree';     // 'tree'|'exploding'|'paused'|'assembling'|'orbiting'|'playing'|'drifting'
let gestureState    = 'IDLE';     // 'IDLE'|'OPEN'|'CLOSED'
let scene2Fallback  = false;      // 摄像头/MediaPipe 失败 → true
let animStartTime   = 0;
let animDuration    = 0;
let animFrom        = null;       // Float32Array 全部参与粒子的起始位置
let animTo          = null;       // Float32Array 目标位置
let animGeos        = [];         // [{ geo, offset }] 参与动画的 geometry 列表
let animTotal       = 0;
let audioPlaying    = false;

// ---- 缓动函数 ----
function easeOutCubic(t)  { return 1 - Math.pow(1 - t, 3); }
function easeInOutQuad(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2; }

// ---- 环形轨道数据（播放键周围的粒子环） ----
const ringRadii  = [];    // 每粒子的轨道半径
const ringSpeeds = [];    // 每粒子的旋转速度 (rad/s)
const ringBaseY  = [];    // 每粒子的基准 Y
const ringOscAmp = [];    // 每粒子的浮动幅度
let   ringAngles = null;  // Float32Array 当前角度

// ---- 生成环形轨道目标坐标 ----
function generateRingTargets(count) {
  const targets = new Float32Array(count * 3);
  ringRadii.length  = 0;
  ringSpeeds.length = 0;
  ringBaseY.length  = 0;
  ringOscAmp.length = 0;

  const rings = [
    { r: 2.5, frac: 0.30, speed: 1.5, yBase: 2.0, ySpread: 0.5, oscAmp: 0.25 },
    { r: 3.5, frac: 0.35, speed: 1.0, yBase: 2.0, ySpread: 0.7, oscAmp: 0.35 },
    { r: 4.5, frac: 0.35, speed: 0.5, yBase: 2.0, ySpread: 0.9, oscAmp: 0.45 },
  ];

  let offset = 0;
  for (const ring of rings) {
    const n = Math.floor(count * ring.frac);
    for (let i = 0; i < n && offset < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const y = ring.yBase + (Math.random() - 0.5) * ring.ySpread;
      targets[offset * 3]     = Math.cos(a) * ring.r;
      targets[offset * 3 + 1] = y;
      targets[offset * 3 + 2] = Math.sin(a) * ring.r;
      ringRadii.push(ring.r);
      ringSpeeds.push(ring.speed);
      ringBaseY.push(ring.yBase);
      ringOscAmp.push(ring.oscAmp);
      offset++;
    }
  }
  // 剩余粒子放外圈
  while (offset < count) {
    const a = Math.random() * Math.PI * 2;
    const y = 2.0 + (Math.random() - 0.5) * 1.0;
    targets[offset * 3]     = Math.cos(a) * 4.5;
    targets[offset * 3 + 1] = y;
    targets[offset * 3 + 2] = Math.sin(a) * 4.5;
    ringRadii.push(4.5);
    ringSpeeds.push(0.5);
    ringBaseY.push(2.0);
    ringOscAmp.push(0.45);
    offset++;
  }

  ringAngles = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    ringAngles[i] = Math.atan2(targets[i * 3 + 2], targets[i * 3]);
  }
  return targets;
}

// ---- 收集所有参与动画的粒子 ----
function collectAnimGeos() {
  animGeos = [];
  animTotal = 0;
  const d = scene2Data;
  // treeGroup 内的粒子
  const treeGeo  = d.treePoints.geometry;
  const grlGeo   = d.garlandPoints.geometry;
  const ornGeo   = d.ornamentPoints.geometry;
  animGeos.push({ geo: treeGeo, offset: animTotal }); animTotal += treeGeo.attributes.position.count;
  animGeos.push({ geo: grlGeo,  offset: animTotal }); animTotal += grlGeo.attributes.position.count;
  animGeos.push({ geo: ornGeo,  offset: animTotal }); animTotal += ornGeo.attributes.position.count;
  // 氛围粒子（世界空间）
  const nearGeo  = d.ambNearPoints.geometry;
  const farGeo   = d.ambFarPoints.geometry;
  animGeos.push({ geo: nearGeo, offset: animTotal, worldSpace: true }); animTotal += nearGeo.attributes.position.count;
  animGeos.push({ geo: farGeo,  offset: animTotal, worldSpace: true }); animTotal += farGeo.attributes.position.count;
}

// ---- 读取所有粒子当前位置到数组 ----
function snapshotPositions() {
  const arr = new Float32Array(animTotal * 3);
  for (const ag of animGeos) {
    const src = ag.geo.attributes.position.array;
    for (let i = 0; i < src.length; i++) {
      arr[ag.offset * 3 + i] = src[i];
    }
  }
  return arr;
}

// ---- 将数组写回所有粒子位置 ----
function writePositions(arr) {
  for (const ag of animGeos) {
    const dst = ag.geo.attributes.position.array;
    for (let i = 0; i < dst.length; i++) {
      dst[i] = arr[ag.offset * 3 + i];
    }
    ag.geo.attributes.position.needsUpdate = true;
  }
}

// ---- 生成散开目标（当前坐标 + 随机偏移） ----
function generateScatterTargets(fromArr) {
  const targets = new Float32Array(animTotal * 3);
  for (let i = 0; i < animTotal; i++) {
    const idx = i * 3;
    // 随机方向
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const dist  = 2 + Math.random() * 3.5;        // 2-5.5 单位
    targets[idx]     = fromArr[idx]     + Math.sin(phi) * Math.cos(theta) * dist;
    targets[idx + 1] = fromArr[idx + 1] + Math.sin(phi) * Math.sin(theta) * dist;
    targets[idx + 2] = fromArr[idx + 2] + Math.cos(phi) * dist;
  }
  return targets;
}

// ---- 触发粒子散开 ----
function triggerParticleExplode() {
  if (scene2Phase !== 'tree') return;
  scene2Phase = 'exploding';
  animStartTime = performance.now();
  animDuration = 1500;

  // 停止旋转、保存姿态
  scene2Data.treeGroup.rotation.y = scene2Data.treeGroup.rotation.y; // 定格

  animFrom = snapshotPositions();
  animTo   = generateScatterTargets(animFrom);

  // 情话文字保持居中显示（不隐藏，仅微调透明度）
  const lm = document.querySelector('.love-message');
  if (lm) lm.style.opacity = '0.8';

  // 气泡飞走
  const bubble = document.querySelector('.speech-bubble');
  if (bubble) bubble.classList.add('gone');

  // 手势提示隐藏
  updateGestureHint('');
}

// ---- 开始聚合为播放键 ----
function startAssemble() {
  scene2Phase = 'assembling';
  animStartTime = performance.now();
  animDuration = 2000;

  animFrom = snapshotPositions();
  animTo   = generateRingTargets(animTotal);
}

// ---- 更新手势提示文字 ----
function updateGestureHint(text) {
  const hint = document.getElementById('gesture-hint');
  if (!hint) return;
  if (text) {
    hint.textContent = text;
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

// ---- 音频播放 ----
let driftStartTime = 0;
let currentAudio   = null;
let progressUpdater = null;

// 预加载音频（场景2初始化时调用）
function preloadAudio() {
  const audio = new Audio('assets/audio/uqd1u-p3pzg.mp3');
  audio.preload = 'auto';
  audio.load();
  currentAudio = audio;
}

function playScene2Audio() {
  if (audioPlaying) return;
  if (!currentAudio) { preloadAudio(); }
  audioPlaying = true;
  scene2Phase = 'playing';

  const audio = currentAudio;
  // 等音频就绪再播放，超时 5s 自动跳过
  const doPlay = () => {
    audio.play().catch(() => {
      setTimeout(() => { if (scene2Phase === 'playing') { scene2Phase = 'drifting'; driftStartTime = performance.now(); } }, 3000);
    });
  };
  if (audio.readyState >= 2) { doPlay(); }
  else { audio.addEventListener('canplay', doPlay, { once: true });
    setTimeout(() => { if (!audioPlaying || audio.paused) { audio.removeEventListener('canplay', doPlay); doPlay(); } }, 5000);
  }

  // 进度条更新
  progressUpdater = setInterval(() => {
    const bar = document.getElementById('progress-bar');
    if (!audio.paused && audio.duration) {
      bar.value = (audio.currentTime / audio.duration) * 100;
      updateTimeDisplay(audio);
    }
  }, 200);

  // 进度条拖动
  const bar = document.getElementById('progress-bar');
  bar.value = 0;
  bar.oninput = () => {
    if (audio.duration) {
      audio.currentTime = (bar.value / 100) * audio.duration;
      updateTimeDisplay(audio);
    }
  };

  // 播放结束
  audio.addEventListener('ended', () => {
    clearInterval(progressUpdater);
    document.getElementById('audio-controls').classList.remove('visible');
    currentAudio = null;
    scene2Phase = 'drifting';
    driftStartTime = performance.now();
  });
}

// ---- 暂停 / 继续 ----
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pause-btn').addEventListener('click', () => {
    if (!currentAudio) return;
    const btn = document.getElementById('pause-btn');
    if (currentAudio.paused) {
      currentAudio.play();
      btn.textContent = '⏸';
      btn.setAttribute('aria-label', '暂停');
    } else {
      currentAudio.pause();
      btn.textContent = '▶';
      btn.setAttribute('aria-label', '播放');
    }
  });
});

// ---- 时间显示 ----
function updateTimeDisplay(audio) {
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  };
  const el = document.getElementById('time-display');
  if (audio.duration && isFinite(audio.duration)) {
    el.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
  } else {
    el.textContent = fmt(audio.currentTime);
  }
}

// ---- 显示播放键（HTML 元素） ----
function showPlayButtonUI() {
  document.getElementById('play-btn').classList.add('visible');
}

// ---- 手势检测回调（简化：张开手挥挥即触发）----
function onHandResults(results) {
  if (scene2Phase !== 'tree' || scene2Fallback) return;

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    gestureState = 'IDLE';
    return;
  }

  const lm = results.multiHandLandmarks[0];
  const wrist = lm[0];
  const fingertips = [4, 8, 12, 16, 20];

  let allFar = true;
  for (const idx of fingertips) {
    const tip = lm[idx];
    const dist = Math.sqrt(
      (tip.x - wrist.x) ** 2 + (tip.y - wrist.y) ** 2 + (tip.z - wrist.z) ** 2
    );
    if (dist < OPEN_THRESHOLD) { allFar = false; break; }
  }

  // 只要五指张开就立即触发（带冷却防止重复）
  if (allFar && gestureState === 'IDLE') {
    gestureState = 'DONE';
    if (scene2Data._autoTimer) { clearInterval(scene2Data._autoTimer); scene2Data._autoTimer = null; }
    triggerParticleExplode();
  }

  // 手移开后重置冷却
  if (!allFar && gestureState === 'DONE') {
    gestureState = 'IDLE';
  }
}

// ---- 摄像头初始化 ----
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    const video = document.getElementById('input-video');
    video.srcObject = stream;
    await video.play();
    return true;
  } catch (e) {
    console.warn('Camera unavailable:', e.message);
    return false;
  }
}

// ---- MediaPipe Hands 初始化 ----
function initHands() {
  try {
    const video = document.getElementById('input-video');
    const hands = new Hands({
      locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onHandResults);

    const cameraUtils = new Camera(video, {
      onFrame: async () => { await hands.send({ image: video }); },
      width: 640,
      height: 480,
    });
    cameraUtils.start();
    scene2Data._hands = hands;
    scene2Data._camUtil = cameraUtils;
    return true;
  } catch (e) {
    console.warn('MediaPipe init failed:', e.message);
    return false;
  }
}

// ---- 兜底模式 ----
function enableFallback() {
  scene2Fallback = true;
  if (scene2Data && scene2Data._autoTimer) { clearInterval(scene2Data._autoTimer); scene2Data._autoTimer = null; }
  updateGestureHint('');
  document.getElementById('fallback-play-btn').classList.add('visible');

  document.getElementById('fallback-play-btn').addEventListener('click', function h(e) {
    this.classList.remove('visible');
    this.removeEventListener('click', h);
    // 兜底按钮触发和挥手一样的粒子动画流程
    triggerParticleExplode();
  });
}

// ---- 主初始化 ----
function initScene2() {
  if (scene2Data) return;

  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;

  /* ======== 1. Three.js 场景 ======== */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 20);
  camera.position.set(0, 2.2, 6.5);
  camera.lookAt(0, 1.5, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // 粒子纹理
  const texSize = 64;
  const texCanvas = document.createElement('canvas');
  texCanvas.width = texCanvas.height = texSize;
  const tctx = texCanvas.getContext('2d');
  const grad = tctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  tctx.fillStyle = grad; tctx.fillRect(0, 0, 64, 64);
  const particleMap = new THREE.CanvasTexture(texCanvas);

  const treeGroup = new THREE.Group();
  scene.add(treeGroup);

  const TREE_H = 4.0, BASE_R = 1.5;

  /* ======== 2. 树身粒子 1850 ======== */
  const TREE_COUNT = 1850;
  const treePos = new Float32Array(TREE_COUNT * 3);
  const treeCol = new Float32Array(TREE_COUNT * 3);
  const pal = ['#ff85a2','#ffb3c6','#ffffff','#ffd700','#ffe4b5'].map(c => new THREE.Color(c));

  for (let i = 0; i < TREE_COUNT; i++) {
    const t = Math.random(), y = t * TREE_H, maxR = BASE_R * (1 - t);
    const r = maxR * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    treePos[i*3]=Math.cos(a)*r; treePos[i*3+1]=y; treePos[i*3+2]=Math.sin(a)*r;
    const c = pal[Math.floor(Math.random()*pal.length)];
    treeCol[i*3]=c.r; treeCol[i*3+1]=c.g; treeCol[i*3+2]=c.b;
  }
  const treeGeo = new THREE.BufferGeometry();
  treeGeo.setAttribute('position', new THREE.BufferAttribute(treePos,3));
  treeGeo.setAttribute('color', new THREE.BufferAttribute(treeCol,3));
  const treeMat = new THREE.PointsMaterial({ size:0.08, map:particleMap, vertexColors:true, blending:THREE.AdditiveBlending, depthWrite:false });
  const treePoints = new THREE.Points(treeGeo, treeMat);
  treeGroup.add(treePoints);

  /* ======== 3. 星星 ======== */
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,TREE_H+0.05,0]),3));
  const starMat = new THREE.PointsMaterial({ size:0.3, map:particleMap, color:0xffd700, blending:THREE.AdditiveBlending, depthWrite:false });
  const starPoint = new THREE.Points(starGeo, starMat); treeGroup.add(starPoint);
  const sg2 = new THREE.BufferGeometry();
  sg2.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,TREE_H+0.05,0]),3));
  treeGroup.add(new THREE.Points(sg2, new THREE.PointsMaterial({ size:0.6, map:particleMap, color:0xffccaa, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.5, transparent:true })));

  /* ======== 4. 彩带 500 ======== */
  const GARLAND_COUNT = 500, SPIRALS = 4, WRAPS = 8;
  const garlandPos = new Float32Array(GARLAND_COUNT*3), garlandCol = new Float32Array(GARLAND_COUNT*3);
  const gPal = ['#ffd700','#ff4088','#ff3333','#ffeef8'].map(c=>new THREE.Color(c));
  const perSpiral = Math.floor(GARLAND_COUNT/SPIRALS);
  for (let s=0;s<SPIRALS;s++){ const ph=(s/SPIRALS)*Math.PI*2;
    for (let j=0;j<perSpiral;j++){ const idx=s*perSpiral+j, t=j/perSpiral, y=t*TREE_H, r=BASE_R*(1-t)*0.92, a=t*Math.PI*2*WRAPS+ph;
      garlandPos[idx*3]=Math.cos(a)*r; garlandPos[idx*3+1]=y; garlandPos[idx*3+2]=Math.sin(a)*r;
      const c=gPal[s%4]; garlandCol[idx*3]=c.r; garlandCol[idx*3+1]=c.g; garlandCol[idx*3+2]=c.b; }}
  const garlandGeo = new THREE.BufferGeometry();
  garlandGeo.setAttribute('position', new THREE.BufferAttribute(garlandPos,3));
  garlandGeo.setAttribute('color', new THREE.BufferAttribute(garlandCol,3));
  const garlandPoints = new THREE.Points(garlandGeo, new THREE.PointsMaterial({ size:0.14, map:particleMap, vertexColors:true, blending:THREE.AdditiveBlending, depthWrite:false }));
  treeGroup.add(garlandPoints);

  /* ======== 6. 装饰球 120 ======== */
  const ORNAMENT_COUNT = 120, ornPos = new Float32Array(ORNAMENT_COUNT*3), ornBase = new Float32Array(ORNAMENT_COUNT), ornPhase = new Float32Array(ORNAMENT_COUNT);
  const oPal = ['#ff1744','#ffab00','#ff6e9f','#fce4ec'].map(c=>new THREE.Color(c));
  for (let i=0;i<ORNAMENT_COUNT;i++){ const t=0.05+Math.random()*0.9, y=t*TREE_H, r=BASE_R*(1-t)*0.95, a=Math.random()*Math.PI*2;
    ornPos[i*3]=Math.cos(a)*r; ornPos[i*3+1]=y; ornPos[i*3+2]=Math.sin(a)*r; ornBase[i]=0.18+Math.random()*0.12; ornPhase[i]=Math.random()*Math.PI*2; }
  const ornGeo = new THREE.BufferGeometry();
  ornGeo.setAttribute('position', new THREE.BufferAttribute(ornPos,3));
  const ornColArr = new Float32Array(ORNAMENT_COUNT*3);
  for (let i=0;i<ORNAMENT_COUNT;i++){ const c=oPal[Math.floor(Math.random()*4)]; ornColArr[i*3]=c.r; ornColArr[i*3+1]=c.g; ornColArr[i*3+2]=c.b; }
  ornGeo.setAttribute('color', new THREE.BufferAttribute(ornColArr,3));
  const ornamentPoints = new THREE.Points(ornGeo, new THREE.PointsMaterial({ size:0.25, map:particleMap, vertexColors:true, blending:THREE.AdditiveBlending, depthWrite:false, transparent:true, opacity:0.85 }));
  treeGroup.add(ornamentPoints);

  /* ======== 7. 氛围粒子 近200+远200 ======== */
  const AMB_NEAR_COUNT = 200, ambNearPos = new Float32Array(AMB_NEAR_COUNT*3), ambNearData = new Float32Array(AMB_NEAR_COUNT*2);
  for (let i=0;i<AMB_NEAR_COUNT;i++){ const a=Math.random()*Math.PI*2, d=1+Math.random()*1.5; ambNearPos[i*3]=Math.cos(a)*d; ambNearPos[i*3+1]=Math.random()*5-1.5; ambNearPos[i*3+2]=Math.sin(a)*d; ambNearData[i*2]=0.5+Math.random()*0.8; ambNearData[i*2+1]=Math.random()*Math.PI*2; }
  const ambNearGeo = new THREE.BufferGeometry();
  ambNearGeo.setAttribute('position', new THREE.BufferAttribute(ambNearPos,3));
  const ambNearPoints = new THREE.Points(ambNearGeo, new THREE.PointsMaterial({ size:0.07, map:particleMap, color:0xfff5f0, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.8, transparent:true }));
  scene.add(ambNearPoints);

  const AMB_FAR_COUNT = 200, ambFarPos = new Float32Array(AMB_FAR_COUNT*3), ambFarData = new Float32Array(AMB_FAR_COUNT*2);
  for (let i=0;i<AMB_FAR_COUNT;i++){ const a=Math.random()*Math.PI*2, d=3+Math.random()*2.5; ambFarPos[i*3]=Math.cos(a)*d; ambFarPos[i*3+1]=Math.random()*5-1.5; ambFarPos[i*3+2]=Math.sin(a)*d; ambFarData[i*2]=0.15+Math.random()*0.35; ambFarData[i*2+1]=Math.random()*Math.PI*2; }
  const ambFarGeo = new THREE.BufferGeometry();
  ambFarGeo.setAttribute('position', new THREE.BufferAttribute(ambFarPos,3));
  const ambFarPoints = new THREE.Points(ambFarGeo, new THREE.PointsMaterial({ size:0.025, map:particleMap, color:0xd4c8e0, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.4, transparent:true }));
  scene.add(ambFarPoints);

  /* ======== 8. 存储引用 ======== */
  scene2Data = {
    scene, camera, renderer, treeGroup, starPoint,
    treePoints, garlandPoints, ornamentPoints, ornBase, ornPhase,
    ambNearPoints, ambNearData, ambFarPoints, ambFarData,
    animId: null, _hands: null, _camUtil: null,
  };
  collectAnimGeos();

  /* ======== 9. 渲染循环 ======== */
  const clock = new THREE.Clock();

  function animate(ts) {
    scene2Data.animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const d = scene2Data;
    const now = ts * 0.001;

    // --- 粒子动画更新 ---
    if (scene2Phase === 'exploding' || scene2Phase === 'assembling') {
      const raw = Math.min((ts - animStartTime) / animDuration, 1);
      const t = scene2Phase === 'exploding' ? easeOutCubic(raw) : easeInOutQuad(raw);

      const tmp = new Float32Array(animTotal * 3);
      for (let i = 0; i < animTotal * 3; i++) {
        tmp[i] = animFrom[i] + (animTo[i] - animFrom[i]) * t;
      }
      writePositions(tmp);

      if (raw >= 1) {
        if (scene2Phase === 'exploding') {
          scene2Phase = 'paused';
          animStartTime = ts;
          animDuration = 1000;
        } else if (scene2Phase === 'assembling') {
          scene2Phase = 'orbiting';
          showPlayButtonUI();
        }
      }
    } else if (scene2Phase === 'paused') {
      if (ts - animStartTime >= animDuration) startAssemble();
    }

    // --- 环绕模式：粒子在环形轨道上持续旋转 ---
    if (scene2Phase === 'orbiting' || scene2Phase === 'playing' || scene2Phase === 'drifting') {
      const speedMul = (scene2Phase === 'playing') ? 2.5 : (scene2Phase === 'drifting' ? 0.3 : 1.0);
      const driftT   = (scene2Phase === 'drifting') ? Math.min((ts - driftStartTime) / 2000, 1) : 0;
      const pos = new Float32Array(animTotal * 3);
      for (let i = 0; i < animTotal; i++) {
        ringAngles[i] += ringSpeeds[i] * dt * speedMul * (1 - driftT * 0.8);
        const a = ringAngles[i];
        const r = ringRadii[i] * (1 + driftT * 4);       // 飘散时半径扩大
        const y = ringBaseY[i] + Math.sin(now * 1.5 + ringAngles[i]) * ringOscAmp[i];
        pos[i * 3]     = Math.cos(a) * r;
        pos[i * 3 + 1] = y + driftT * 3;                 // 飘散时整体上浮
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      writePositions(pos);

      if (scene2Phase === 'drifting' && driftT >= 1) {
        switchScene('scene3');
        const scene3 = document.getElementById('scene3');
        if (scene3 && !prefersReducedMotion) {
          scene3.classList.add('animate__animated', 'animate__fadeIn');
        }
      }
    }

    // --- 正常模式：树旋转 ---
    if (scene2Phase === 'tree') {
      d.treeGroup.rotation.y += 0.3 * dt;
    }

    // --- 星星脉动 ---
    const pulse = 1 + 0.15 * Math.sin(now * 0.004);
    d.starPoint.material.size = 0.3 * pulse;

    // --- 装饰球闪烁 ---
    if (scene2Phase !== 'orbiting' && scene2Phase !== 'playing' && scene2Phase !== 'drifting') {
      const ob = 1 + 0.2 * Math.sin(now * 2.5);
      d.ornamentPoints.material.size = 0.25 * ob;
      d.ornamentPoints.material.opacity = 0.7 + 0.3 * Math.abs(Math.sin(now * 3));
    }

    // --- 近景粒子 ---
    if (scene2Phase === 'tree') {
      const narr = d.ambNearPoints.geometry.attributes.position.array;
      for (let i = 0; i < AMB_NEAR_COUNT; i++) {
        narr[i*3+1] -= d.ambNearData[i*2] * dt;
        if (narr[i*3+1] < -1.5) { narr[i*3+1]=5.5; const a=Math.random()*Math.PI*2, dd=1+Math.random()*1.5; narr[i*3]=Math.cos(a)*dd; narr[i*3+2]=Math.sin(a)*dd; }
        narr[i*3] += Math.sin(now + d.ambNearData[i*2+1]) * 0.002;
      }
      d.ambNearPoints.geometry.attributes.position.needsUpdate = true;

      const farr = d.ambFarPoints.geometry.attributes.position.array;
      for (let i = 0; i < AMB_FAR_COUNT; i++) {
        farr[i*3+1] -= d.ambFarData[i*2] * dt;
        if (farr[i*3+1] < -1.5) { farr[i*3+1]=5.5; const a=Math.random()*Math.PI*2, dd=3+Math.random()*2.5; farr[i*3]=Math.cos(a)*dd; farr[i*3+2]=Math.sin(a)*dd; }
        farr[i*3] += Math.sin(now*0.6 + d.ambFarData[i*2+1]) * 0.0008;
      }
      d.ambFarPoints.geometry.attributes.position.needsUpdate = true;
    }

    renderer.render(d.scene, d.camera);
  }
  requestAnimationFrame(animate);

  /* ======== 10. 8秒倒计时自动推进（不依赖摄像头） ======== */
  let countdown = 8;
  scene2Data._autoTimer = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      updateGestureHint('挥手或等 ' + countdown + ' 秒自动进入');
    } else {
      clearInterval(scene2Data._autoTimer);
      scene2Data._autoTimer = null;
      if (scene2Phase === 'tree') {
        try { triggerParticleExplode(); } catch(e) { enableFallback(); }
      }
    }
  }, 1000);

  /* ======== 11. 预加载音频 ======== */
  preloadAudio();

  /* ======== 11. 播放键点击（HTML 元素） ======== */
  document.getElementById('play-btn').addEventListener('click', () => {
    if (scene2Phase !== 'orbiting') return;
    document.getElementById('play-btn').classList.remove('visible');
    playScene2Audio();
  });

  /* ======== 11. 摄像头 + MediaPipe（轮询等待 CDN 加载） ======== */
  let pollTries = 0;
  const MAX_POLL = 60;  // 最多等 10 秒（每 200ms 查一次）

  function tryStartCamera() {
    pollTries++;
    // 等 CDN 脚本就绪
    if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
      if (pollTries < MAX_POLL) {
        setTimeout(tryStartCamera, 200);
      } else {
        console.warn('MediaPipe CDN 加载超时，启用兜底');
        enableFallback();
      }
      return;
    }
    // 脚本就绪，尝试摄像头
    initCamera().then(camOk => {
      if (!camOk) { enableFallback(); return; }
      const handsOk = initHands();
      if (!handsOk) enableFallback();
    }).catch(() => enableFallback());
  }

  setTimeout(tryStartCamera, 500);  // 给 CDN 0.5s 缓冲

  /* ======== 12. Resize ======== */
  window.addEventListener('resize', onScene2Resize);
}

function onScene2Resize() {
  if (!scene2Data) return;
  scene2Data.camera.aspect = window.innerWidth / window.innerHeight;
  scene2Data.camera.updateProjectionMatrix();
  scene2Data.renderer.setSize(window.innerWidth, window.innerHeight);
}

function destroyScene2() {
  if (!scene2Data) return;
  window.removeEventListener('resize', onScene2Resize);
  cancelAnimationFrame(scene2Data.animId);

  // 停止摄像头
  if (scene2Data._camUtil) {
    try { scene2Data._camUtil.stop(); } catch(e) {}
  }
  if (scene2Data._hands) {
    try { scene2Data._hands.close(); } catch(e) {}
  }

  [scene2Data.scene, scene2Data.treeGroup].forEach(root => {
    root.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
    });
  });
  scene2Data.renderer.dispose();

  // 重置状态
  scene2Phase = 'tree';
  gestureState = 'IDLE';
  scene2Fallback = false;
  animFrom = null; animTo = null; animGeos = []; animTotal = 0;
  audioPlaying = false;
  document.getElementById('play-btn').classList.remove('visible');
  document.getElementById('audio-controls').classList.remove('visible');
  document.getElementById('fallback-play-btn').classList.remove('visible');
  if (scene2Data._autoTimer) { clearInterval(scene2Data._autoTimer); scene2Data._autoTimer = null; }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (progressUpdater) { clearInterval(progressUpdater); progressUpdater = null; }
  const lm = document.querySelector('.love-message');
  if (lm) lm.style.opacity = '1';
  const bubble = document.querySelector('.speech-bubble');
  if (bubble) bubble.classList.remove('gone');
  updateGestureHint('对着摄像头挥挥手吧～');
  scene2Data = null;
}
