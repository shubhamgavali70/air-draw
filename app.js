// Air Draw — draw in the air with your index finger.
//
// MediaPipe Hands gives us 21 landmarks per hand (normalized 0..1).
// Landmark indices we care about:
//   0  wrist
//   4  thumb tip           (2 = IP joint)
//   8  index tip           (6 = PIP joint)
//   12 middle tip          (10 = PIP joint)
//   16 ring tip            (14 = PIP joint)
//   20 pinky tip           (18 = PIP joint)

const video = document.getElementById("video");
const ink = document.getElementById("ink");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const gestureEl = document.getElementById("gesture");
const sizeInput = document.getElementById("size");
const clearBtn = document.getElementById("clear");
const saveBtn = document.getElementById("save");
const swatches = document.getElementById("swatches");

const inkCtx = ink.getContext("2d");
const overlayCtx = overlay.getContext("2d");

let color = "#ff2d55";
let brush = parseInt(sizeInput.value, 10);

// Exponential-moving-average smoothing on the index-fingertip position so
// the strokes don't jitter with every frame of hand-tracker noise.
let smoothed = null; // {x, y} in canvas pixels
const SMOOTH = 0.45; // higher = snappier, lower = smoother

// Track whether we were drawing on the previous frame so we can start a
// fresh path (moveTo) on a pen-down transition.
let wasDrawing = false;

// Gesture hysteresis — once we're in `draw`, require several consecutive
// non-draw frames before lifting the pen. This keeps strokes unbroken when
// the tracker glitches a single frame (e.g. a stray "middle finger up").
let currentGesture = "idle";
let pendingGesture = "idle";
let pendingFrames = 0;
const EXIT_DRAW_FRAMES = 4;   // frames of non-draw before we stop drawing
const ENTER_DRAW_FRAMES = 1;  // instant pen-down when user raises index

// Brief hand-tracker dropouts shouldn't reset the pen — hold state for a
// few frames and only give up if the hand is gone for longer than that.
let missingFrames = 0;
const MAX_MISSING = 4;

// "Clear palm" gesture needs to be held for a beat so a momentary frame
// of all-fingers-up doesn't wipe the board.
let palmHeldFrames = 0;
const PALM_HOLD_REQUIRED = 12; // ~0.4s at 30fps

function resizeCanvases() {
  const { innerWidth: w, innerHeight: h } = window;
  // Preserve existing ink when resizing so a window resize doesn't nuke the drawing.
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

// ---- Toolbar wiring ---------------------------------------------------------

swatches.addEventListener("click", (e) => {
  const el = e.target.closest(".swatch");
  if (!el) return;
  color = el.dataset.color;
  swatches.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s === el));
});

sizeInput.addEventListener("input", () => {
  brush = parseInt(sizeInput.value, 10);
});

clearBtn.addEventListener("click", () => clearInk());

saveBtn.addEventListener("click", () => {
  // Flatten video + ink into one image. Because the CSS mirrors the canvas,
  // we mirror back so saved output matches what the user sees.
  const out = document.createElement("canvas");
  out.width = ink.width;
  out.height = ink.height;
  const ctx = out.getContext("2d");
  ctx.save();
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(ink, 0, 0);
  ctx.restore();

  const link = document.createElement("a");
  link.download = `air-draw-${Date.now()}.png`;
  link.href = out.toDataURL("image/png");
  link.click();
});

function clearInk() {
  inkCtx.clearRect(0, 0, ink.width, ink.height);
}

// ---- Gesture classification -------------------------------------------------

// Robust finger-extended test.
//
// The cheap version (tip.y < pip.y) flickers near threshold — a finger that's
// mostly down but not fully curled jumps between states between frames, which
// shows up as broken strokes. We fix that in two ways:
//   1. Compare tip to the MCP knuckle (further reference point → bigger delta
//      between extended and curled), normalized by palm size so the threshold
//      is scale-invariant.
//   2. The threshold is intentionally asymmetric so a clearly-extended index
//      stays "up" even if it wiggles a bit.
function fingersUp(landmarks, handedness) {
  const tipIds = [4, 8, 12, 16, 20];
  const mcpIds = [2, 5, 9, 13, 17];
  const pipIds = [3, 6, 10, 14, 18];

  // Palm scale: distance from wrist (0) to middle-finger MCP (9). Using this
  // as a reference means the finger-extended test doesn't depend on how close
  // the hand is to the camera.
  const wrist = landmarks[0];
  const midMcp = landmarks[9];
  const palm = Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y) || 1e-6;

  const up = [];

  // Thumb — sideways, so compare x.
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];
  const isRight = handedness === "Right";
  up.push(isRight ? thumbTip.x < thumbIp.x : thumbTip.x > thumbIp.x);

  // Index..pinky — finger is "up" when its tip sits meaningfully above its MCP
  // joint (in image coords, smaller y = higher). Threshold is a fraction of
  // palm size so it scales with distance.
  for (let i = 1; i < 5; i++) {
    const tip = landmarks[tipIds[i]];
    const mcp = landmarks[mcpIds[i]];
    const pip = landmarks[pipIds[i]];
    const vertical = (mcp.y - tip.y) / palm;           // positive when extended
    const pipExtended = tip.y < pip.y - 0.01 * palm;   // backup heuristic
    up.push(vertical > 0.35 && pipExtended);
  }
  return up; // [thumb, index, middle, ring, pinky]
}

function classify(up) {
  const [, idx, mid, ring, pinky] = up;
  // "Open palm" clear — all four non-thumb fingers up.
  if (idx && mid && ring && pinky) return "clear";
  // Two-finger hover — index + middle, ring + pinky down.
  if (idx && mid && !ring && !pinky) return "hover";
  // Draw: index up, other non-thumb fingers down. Thumb is ignored because
  // thumb-up/down flickers a lot and doesn't affect the intent to draw.
  if (idx && !mid && !ring && !pinky) return "draw";
  return "idle";
}

// Hysteresis wrapper: instant pen-down, debounced pen-up. Keeps strokes
// unbroken through transient misclassifications.
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

// Map a normalized MediaPipe landmark (0..1 on the source video frame) to
// canvas pixels, accounting for CSS `object-fit: cover` — the video is
// scaled up to cover the viewport and part of it is cropped. Without this,
// the pen cursor sits noticeably offset from the fingertip on non-16:9
// windows.
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

// ---- MediaPipe setup --------------------------------------------------------

const hands = new Hands({
  locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  // Looser thresholds → fewer per-frame dropouts, which matters more for
  // stroke continuity than the occasional false positive.
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.4,
});

hands.onResults(onResults);

function onResults(results) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const landmarks = results.multiHandLandmarks?.[0];
  const handed = results.multiHandedness?.[0]?.label;

  // Brief hand-tracker dropouts: keep state so a 1-2 frame gap doesn't
  // restart the stroke. Only after MAX_MISSING frames do we really give up.
  if (!landmarks) {
    missingFrames += 1;
    if (missingFrames > MAX_MISSING) {
      gestureEl.textContent = "no hand";
      smoothed = null;
      wasDrawing = false;
      palmHeldFrames = 0;
      currentGesture = "idle";
      pendingGesture = "idle";
      pendingFrames = 0;
    } else if (smoothed) {
      // Redraw the cursor in its last position so the user gets feedback.
      drawCursor(smoothed.x, smoothed.y, "rgba(255,255,255,0.45)", brush, false);
    }
    return;
  }
  missingFrames = 0;

  const up = fingersUp(landmarks, handed);
  const raw = classify(up);
  const gesture = stableGesture(raw);

  // Pen tip = index fingertip (landmark 8). Map through cover-fit transform
  // so the cursor lines up exactly under the user's finger in the video.
  const tipCanvas = landmarkToCanvas(landmarks[8]);

  smoothed = smoothed
    ? {
        x: smoothed.x + (tipCanvas.x - smoothed.x) * SMOOTH,
        y: smoothed.y + (tipCanvas.y - smoothed.y) * SMOOTH,
      }
    : tipCanvas;

  if (gesture === "clear") {
    palmHeldFrames += 1;
    drawCursor(smoothed.x, smoothed.y, "rgba(255,80,80,0.95)", brush);
    drawPalmProgress(palmHeldFrames / PALM_HOLD_REQUIRED);
    if (palmHeldFrames >= PALM_HOLD_REQUIRED) {
      clearInk();
      palmHeldFrames = 0;
    }
    wasDrawing = false;
  } else {
    palmHeldFrames = 0;

    if (gesture === "draw") {
      if (!wasDrawing) {
        inkCtx.beginPath();
        inkCtx.moveTo(smoothed.x, smoothed.y);
      } else {
        inkCtx.lineTo(smoothed.x, smoothed.y);
        inkCtx.strokeStyle = color;
        inkCtx.lineWidth = brush;
        inkCtx.stroke();
        // Re-seed so the next segment picks up the current style values.
        inkCtx.beginPath();
        inkCtx.moveTo(smoothed.x, smoothed.y);
      }
      wasDrawing = true;
      drawCursor(smoothed.x, smoothed.y, color, brush, true);
    } else {
      wasDrawing = false;
      drawCursor(smoothed.x, smoothed.y, "rgba(255,255,255,0.9)", brush, false);
    }
  }

  gestureEl.textContent = {
    draw: "✏️  drawing",
    hover: "✌️  hover",
    clear: "🖐  clearing…",
    idle: "· idle",
  }[gesture];
}

// ---- Cursor / HUD rendering -------------------------------------------------

function drawCursor(x, y, stroke, size, filled = false) {
  overlayCtx.save();
  overlayCtx.beginPath();
  overlayCtx.arc(x, y, Math.max(size / 2 + 4, 8), 0, Math.PI * 2);
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
  const w = 160, h = 6, x = (overlay.width - w) / 2, y = 48;
  overlayCtx.save();
  // The overlay canvas is mirrored, so text/UI drawn into it would appear
  // reversed. For the progress bar (symmetric) it doesn't matter.
  overlayCtx.fillStyle = "rgba(255,255,255,0.15)";
  overlayCtx.fillRect(x, y, w, h);
  overlayCtx.fillStyle = "#ff2d55";
  overlayCtx.fillRect(x, y, w * Math.min(1, frac), h);
  overlayCtx.restore();
}

// ---- Camera loop ------------------------------------------------------------

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
