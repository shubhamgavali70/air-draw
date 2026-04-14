# Air Draw

Write in the air with your finger — a webcam-based drawing app that tracks your
index fingertip with MediaPipe Hands and paints onto a canvas overlaid on the
video feed.

## Gestures

- ☝️ **Index finger only** — draw
- ✌️ **Index + middle** — hover (pen lift)
- 🖐 **Open palm (all four fingers up)** — hold briefly to clear the board

A color palette, brush size slider, Clear button, and Save PNG button live in
the toolbar at the bottom of the screen.

## Running locally

No build step — it's a static HTML/CSS/JS app using MediaPipe via CDN.

```sh
python3 -m http.server 5173
# open http://localhost:5173
```

Grant camera access when prompted. Camera access requires a secure context
(`https://` or `localhost`), so `file://` won't work in most browsers.

## How it works

- **MediaPipe Hands** provides 21 3D landmarks per hand each frame.
- **Finger-extended test** compares each fingertip's y to its MCP knuckle,
  normalized by palm size so the threshold is scale-invariant.
- **Gesture hysteresis** keeps strokes unbroken — instant pen-down, but
  requires several consecutive non-draw frames to lift the pen.
- **Brief-dropout tolerance** holds state through 1–4 frame tracker losses.
- **EMA smoothing** on the fingertip position kills jitter.
- Ink is drawn to a `<canvas>` stacked over a mirrored `<video>`; Save PNG
  flattens them un-mirrored so the exported image matches what you saw.
