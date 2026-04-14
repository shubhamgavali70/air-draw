// Air Draw — draw in the air with your index finger.
//
// MediaPipe Hands gives us 21 landmarks per hand (normalized 0..1).
// Landmarks we care about:
//   0  wrist      5,9,13,17 MCP knuckles (index,middle,ring,pinky)
//   4  thumb tip  (3 = IP joint)
//   8  index tip  (6 = PIP joint)
//   12 middle tip (10 = PIP joint)
//   16 ring tip   (14 = PIP joint)
//   20 pinky tip  (18 = PIP joint)

const video = document.getElementById("video");
const ink = document.getElementById("ink");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const gestureEl = document.getElementById("gesture");
const sizeInput = document.getElementById("size");
const rainbowInput = document.getElementById("rainbow");
const clearBtn = document.getElementById("clear");
const saveBtn = document.getElementById("save");
const swatches = document.getElementById("swatches");
const brushes = document.getElementById("brushes");
const pickerOverlay = document.getElementById("picker-overlay");
const shatterLayer = document.getElementById("shatter-layer");

const inkCtx = ink.getContext("2d");
const overlayCtx = overlay.getContext("2d");

let color = "#ff2d55";
let brushSize = parseInt(sizeInput.value, 10);
let rainbow = false;

// Brush model.
// mode = 'line'  → classic canvas stroke (with optional rainbow hue cycling)
// mode = 'stamp' → stamp a cached emoji/DOM-snapshot canvas along the path
let brush = { mode: "line", stamp: null, stampId: "line" };

// Smoothing / gesture state.
let smoothed = null;
const SMOOTH = 0.45;
let wasDrawing = false;
let lastStrokePt = null;     // last point a segment was drawn to (pixels)
let strokeDistance = 0;      // cumulative distance within current stroke
let strokeHue = 0;           // starting hue for rainbow mode per stroke
let lastTimestamp = 0;       // for velocity calc

let currentGesture = "idle";
let pendingGesture = "idle";
let pendingFrames = 0;
const EXIT_DRAW_FRAMES = 4;
const ENTER_DRAW_FRAMES = 1;

let missingFrames = 0;
const MAX_MISSING = 4;

let palmHeldFrames = 0;
const PALM_HOLD_REQUIRED = 12;

// ---- Canvas sizing ---------------------------------------------------------

function resizeCanvases() {
  const { innerWidth: w, innerHeight: h } = window;
  const snapshot = document.createElement("canvas");
  snapshot.width = ink.width || w;
  snapshot.height = ink.height || h;
  snapshot.getContext("2d").drawImage(ink, 0, 0);

  for (const c of [ink, overlay]) {
    c.width = w;
    c.height = h;
  }
  inkCtx.drawImage(snapshot, 0, 0, w, h);

  inkCtx.lineCap = "round";
  inkCtx.lineJoin = "round";
}
window.addEventListener("resize", resizeCanvases);
resizeCanvases();

// ---- Toolbar wiring --------------------------------------------------------

swatches.addEventListener("click", (e) => {
  const el = e.target.closest(".swatch");
  if (!el) return;
  color = el.dataset.color;
  swatches.querySelectorAll(".swatch").forEach((s) =>
    s.classList.toggle("active", s === el)
  );
});

sizeInput.addEventListener("input", () => {
  brushSize = parseInt(sizeInput.value, 10);
});

rainbowInput.addEventListener("change", () => {
  rainbow = rainbowInput.checked;
});

brushes.addEventListener("click", async (e) => {
  const el = e.target.closest(".brush");
  if (!el) return;

  if (el.dataset.brush === "line") {
    setBrush({ mode: "line", stamp: null, stampId: "line" });
    setActiveBrush(el);
    return;
  }
  if (el.dataset.brush === "stamp") {
    setActiveBrush(el);
    const emoji = el.dataset.emoji;
    const stamp = await makeEmojiStamp(emoji);
    setBrush({ mode: "stamp", stamp, stampId: `emoji:${emoji}` });
    return;
  }
  if (el.dataset.brush === "pick") {
    setActiveBrush(el);
    startDomPicker();
    return;
  }
});

function setActiveBrush(el) {
  brushes.querySelectorAll(".brush").forEach((b) => b.classList.toggle("active", b === el));
}
function setBrush(next) {
  brush = next;
}

clearBtn.addEventListener("click", () => runShatterClear());

saveBtn.addEventListener("click", () => {
  const out = document.createElement("canvas");
  out.width = ink.width;
  out.height = ink.height;
  const ctx = out.getContext("2d");
  // Mirror back so the exported image reads the right way.
  ctx.save();
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(ink, 0, 0);
  ctx.restore();

  const a = document.createElement("a");
  a.download = `air-draw-${Date.now()}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
});

function clearInkImmediate() {
  inkCtx.clearRect(0, 0, ink.width, ink.height);
}

// ---- html2canvas-powered stamp builders -----------------------------------

// Render a styled emoji into an offscreen div, then rasterize it via
// html2canvas. Doing it through CSS (gradient backing, drop shadow, rotation)
// gives richer-looking stamps than direct ctx.fillText(emoji).
async function makeEmojiStamp(emoji) {
  const host = document.createElement("div");
  host.style.cssText = `
    position: fixed;
    top: -9999px;
    left: -9999px;
    width: 140px;
    height: 140px;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 35% 30%,
      rgba(255,255,255,0.85), rgba(255,255,255,0) 60%);
    border-radius: 50%;
    filter: drop-shadow(0 6px 14px rgba(0,0,0,0.35));
    font-size: 96px;
    line-height: 1;
    font-family: "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;
    color: ${color};
  `;
  host.textContent = emoji;
  document.body.appendChild(host);
  try {
    const canvas = await html2canvas(host, {
      backgroundColor: null,
      scale: 1,
      logging: false,
      useCORS: true,
    });
    return canvas;
  } finally {
    host.remove();
  }
}

// ---- DOM-element picker: turn ANY element on the page into a brush --------

let pickBindings = null;

function startDomPicker() {
  pickerOverlay.hidden = false;
  let highlighted = null;

  // Temporarily let mouse events through for hit-testing, but the overlay's
  // own crosshair cursor still applies because it's the topmost element.
  pickerOverlay.style.pointerEvents = "none";

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // Don't allow picking the shatter layer (empty), the ink/overlay canvases
    // (they're giant and transparent), or the picker itself.
    if (!el || el === pickerOverlay || el === ink || el === overlay || el === video) return;
    if (highlighted && highlighted !== el) highlighted.classList.remove("pick-highlight");
    highlighted = el;
    highlighted.classList.add("pick-highlight");
  };

  const cleanup = () => {
    pickerOverlay.hidden = true;
    pickerOverlay.style.pointerEvents = "";
    if (highlighted) highlighted.classList.remove("pick-highlight");
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    pickBindings = null;
  };

  const onClick = async (e) => {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === pickerOverlay) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();

    statusEl.textContent = "Rasterizing brush…";
    try {
      const canvas = await html2canvas(target, {
        backgroundColor: null,
        scale: 1,
        logging: false,
        useCORS: true,
      });
      setBrush({
        mode: "stamp",
        stamp: canvas,
        stampId: `dom:${target.tagName}:${Date.now()}`,
      });
      statusEl.textContent = "Tracking hand";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Couldn't capture that element — try another.";
    }
  };

  const onKey = (e) => {
    if (e.key === "Escape") cleanup();
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  pickBindings = { cleanup };
}

// ---- Shatter-clear animation ----------------------------------------------

let shatterRunning = false;

async function runShatterClear() {
  if (shatterRunning) return;
  shatterRunning = true;

  // Snapshot the current ink into an image that we can tile. Using the canvas
  // itself (vs. html2canvas on a wrapper) is faster and doesn't need any
  // DOM-font-loading detour. html2canvas still gets used for stamp brushes.
  const snapshotUrl = ink.toDataURL("image/png");
  const { innerWidth: W, innerHeight: H } = window;

  // Grid of tiles.
  const cols = 14;
  const rows = Math.round(cols * (H / W));
  const tileW = W / cols;
  const tileH = H / rows;

  // Each shard is a div with the full-frame image set as background-position
  // to reveal its one tile.
  const durationMs = 900;
  const shards = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const div = document.createElement("div");
      div.className = "shard";
      div.style.cssText = `
        width: ${tileW}px;
        height: ${tileH}px;
        left: ${x * tileW}px;
        top: ${y * tileH}px;
        background-image: url(${snapshotUrl});
        background-position: ${-x * tileW}px ${-y * tileH}px;
        background-size: ${W}px ${H}px;
      `;
      const dx = (Math.random() - 0.5) * 600;
      const dy = 400 + Math.random() * 400;
      const rot = (Math.random() - 0.5) * 720;
      const scale = 0.3 + Math.random() * 0.6;
      div.style.setProperty("--dx", `${dx}px`);
      div.style.setProperty("--dy", `${dy}px`);
      div.style.setProperty("--rot", `${rot}deg`);
      div.style.setProperty("--scale", scale);
      div.style.animation = `shard-fall ${durationMs}ms cubic-bezier(0.4, 0, 0.8, 1) forwards`;
      div.style.animationDelay = `${Math.random() * 120}ms`;
      shatterLayer.appendChild(div);
      shards.push(div);
    }
  }

  // Clear the ink under the shards immediately so the shards *are* the
  // visible representation of the drawing.
  clearInkImmediate();

  await new Promise((r) => setTimeout(r, durationMs + 150));
  for (const s of shards) s.remove();
  shatterRunning = false;
}

// ---- Gesture classification ------------------------------------------------

function fingersUp(landmarks, handedness) {
  const tipIds = [4, 8, 12, 16, 20];
  const mcpIds = [2, 5, 9, 13, 17];
  const pipIds = [3, 6, 10, 14, 18];

  const wrist = landmarks[0];
  const midMcp = landmarks[9];
  const palm = Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y) || 1e-6;

  const up = [];
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];
  const isRight = handedness === "Right";
  up.push(isRight ? thumbTip.x < thumbIp.x : thumbTip.x > thumbIp.x);

  for (let i = 1; i < 5; i++) {
    const tip = landmarks[tipIds[i]];
    const mcp = landmarks[mcpIds[i]];
    const pip = landmarks[pipIds[i]];
    const vertical = (mcp.y - tip.y) / palm;
    const pipExtended = tip.y < pip.y - 0.01 * palm;
    up.push(vertical > 0.35 && pipExtended);
  }
  return up;
}

function classify(up) {
  const [, idx, mid, ring, pinky] = up;
  if (idx && mid && ring && pinky) return "clear";
  if (idx && mid && !ring && !pinky) return "hover";
  if (idx && !mid && !ring && !pinky) return "draw";
  return "idle";
}

function stableGesture(raw) {
  if (raw === currentGesture) {
    pendingGesture = raw;
    pendingFrames = 0;
    return currentGesture;
  }
  if (raw !== pendingGesture) {
    pendingGesture = raw;
    pendingFrames = 1;
  } else {
    pendingFrames += 1;
  }
  const needed =
    currentGesture === "draw" && raw !== "draw" ? EXIT_DRAW_FRAMES : ENTER_DRAW_FRAMES;
  if (pendingFrames >= needed) {
    currentGesture = raw;
    pendingFrames = 0;
  }
  return currentGesture;
}

function landmarkToCanvas(lm) {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const cw = overlay.width;
  const ch = overlay.height;
  const scale = Math.max(cw / vw, ch / vh);
  const sw = vw * scale;
  const sh = vh * scale;
  const ox = (cw - sw) / 2;
  const oy = (ch - sh) / 2;
  return { x: lm.x * sw + ox, y: lm.y * sh + oy };
}

// ---- Rendering -------------------------------------------------------------

function drawLineSegment(a, b, velocity) {
  // Velocity-reactive width: 20% thinner for fast strokes, up to 20% thicker
  // when nearly still. Keeps fast flicks light and hold-points heavy.
  const v = Math.min(1, velocity / 40);
  const widthScale = 1.2 - v * 0.4;

  if (rainbow) {
    strokeHue = (strokeHue + 4) % 360;
    inkCtx.strokeStyle = `hsl(${strokeHue} 95% 60%)`;
  } else {
    inkCtx.strokeStyle = color;
  }
  inkCtx.lineWidth = brushSize * widthScale;
  inkCtx.beginPath();
  inkCtx.moveTo(a.x, a.y);
  inkCtx.lineTo(b.x, b.y);
  inkCtx.stroke();
}

function stampAt(x, y, velocity) {
  if (!brush.stamp) return;
  const stamp = brush.stamp;
  // Stamp size tracks the brush slider — slider now goes up to 60, so we map
  // that to a stamp diameter range that feels usable.
  const base = brushSize * 3;
  const v = Math.min(1, velocity / 40);
  const jitter = 1 - v * 0.25 + (Math.random() - 0.5) * 0.15;
  const size = Math.max(14, base * jitter);
  const angle = (Math.random() - 0.5) * 0.8; // ±~23°
  const aspect = stamp.height / stamp.width;

  inkCtx.save();
  inkCtx.translate(x, y);
  inkCtx.rotate(angle);
  inkCtx.globalAlpha = 0.92;
  inkCtx.drawImage(stamp, -size / 2, -(size * aspect) / 2, size, size * aspect);
  inkCtx.restore();
}

// ---- MediaPipe -------------------------------------------------------------

const hands = new Hands({
  locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
});
hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.4,
});
hands.onResults(onResults);

function onResults(results) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const landmarks = results.multiHandLandmarks?.[0];
  const handed = results.multiHandedness?.[0]?.label;
  const now = performance.now();
  const dt = Math.max(1, now - (lastTimestamp || now));
  lastTimestamp = now;

  if (!landmarks) {
    missingFrames += 1;
    if (missingFrames > MAX_MISSING) {
      gestureEl.textContent = "no hand";
      smoothed = null;
      wasDrawing = false;
      lastStrokePt = null;
      palmHeldFrames = 0;
      currentGesture = "idle";
      pendingGesture = "idle";
      pendingFrames = 0;
    } else if (smoothed) {
      drawCursor(smoothed.x, smoothed.y, "rgba(255,255,255,0.45)", brushSize, false);
    }
    return;
  }
  missingFrames = 0;

  const up = fingersUp(landmarks, handed);
  const raw = classify(up);
  const gesture = stableGesture(raw);

  const tipCanvas = landmarkToCanvas(landmarks[8]);
  const prev = smoothed;
  smoothed = prev
    ? {
        x: prev.x + (tipCanvas.x - prev.x) * SMOOTH,
        y: prev.y + (tipCanvas.y - prev.y) * SMOOTH,
      }
    : tipCanvas;

  // Pixels-per-frame. Used for velocity-reactive rendering.
  const vel = prev ? Math.hypot(smoothed.x - prev.x, smoothed.y - prev.y) : 0;

  if (gesture === "clear") {
    palmHeldFrames += 1;
    drawCursor(smoothed.x, smoothed.y, "rgba(255,80,80,0.95)", brushSize);
    drawPalmProgress(palmHeldFrames / PALM_HOLD_REQUIRED);
    if (palmHeldFrames >= PALM_HOLD_REQUIRED) {
      runShatterClear();
      palmHeldFrames = 0;
    }
    wasDrawing = false;
    lastStrokePt = null;
  } else {
    palmHeldFrames = 0;

    if (gesture === "draw") {
      if (!wasDrawing) {
        // Start of a fresh stroke.
        lastStrokePt = { x: smoothed.x, y: smoothed.y };
        strokeDistance = 0;
        strokeHue = Math.random() * 360;
        if (brush.mode === "stamp") stampAt(smoothed.x, smoothed.y, vel);
      } else {
        if (brush.mode === "line") {
          drawLineSegment(lastStrokePt, smoothed, vel);
        } else if (brush.mode === "stamp") {
          // Walk along the segment and drop stamps every `step` pixels so
          // fast hand motion doesn't leave gaps and slow motion doesn't
          // pile stamps on top of each other.
          const dx = smoothed.x - lastStrokePt.x;
          const dy = smoothed.y - lastStrokePt.y;
          const dist = Math.hypot(dx, dy);
          const step = Math.max(brushSize * 1.6, 18);
          let walked = step - (strokeDistance % step);
          while (walked < dist) {
            const t = walked / dist;
            stampAt(lastStrokePt.x + dx * t, lastStrokePt.y + dy * t, vel);
            walked += step;
          }
          strokeDistance += dist;
        }
        lastStrokePt = { x: smoothed.x, y: smoothed.y };
      }
      wasDrawing = true;
      drawCursor(smoothed.x, smoothed.y, color, brushSize, true);
    } else {
      wasDrawing = false;
      lastStrokePt = null;
      drawCursor(smoothed.x, smoothed.y, "rgba(255,255,255,0.9)", brushSize, false);
    }
  }

  gestureEl.textContent = {
    draw: brush.mode === "stamp" ? "🖼  stamping" : "✏️  drawing",
    hover: "✌️  hover",
    clear: "🖐  clearing…",
    idle: "· idle",
  }[gesture];
}

function drawCursor(x, y, stroke, size, filled = false) {
  overlayCtx.save();
  overlayCtx.beginPath();
  overlayCtx.arc(x, y, Math.max(size / 2 + 4, 10), 0, Math.PI * 2);
  overlayCtx.strokeStyle = stroke;
  overlayCtx.lineWidth = 2;
  if (filled) {
    overlayCtx.fillStyle = stroke;
    overlayCtx.globalAlpha = 0.35;
    overlayCtx.fill();
    overlayCtx.globalAlpha = 1;
  }
  overlayCtx.stroke();
  overlayCtx.restore();
}

function drawPalmProgress(frac) {
  const w = 180, h = 6, x = (overlay.width - w) / 2, y = 54;
  overlayCtx.save();
  overlayCtx.fillStyle = "rgba(255,255,255,0.18)";
  overlayCtx.fillRect(x, y, w, h);
  const grad = overlayCtx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, "#ff2d55");
  grad.addColorStop(1, "#ffcc00");
  overlayCtx.fillStyle = grad;
  overlayCtx.fillRect(x, y, w * Math.min(1, frac), h);
  overlayCtx.restore();
}

// ---- Camera loop -----------------------------------------------------------

async function start() {
  try {
    statusEl.textContent = "Requesting camera…";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    statusEl.textContent = "Tracking hand";

    const camera = new Camera(video, {
      onFrame: async () => {
        await hands.send({ image: video });
      },
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
    });
    camera.start();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Camera error: ${err.message}`;
  }
}

start();
