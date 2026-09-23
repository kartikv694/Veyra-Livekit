/**
 * The MediaPipe-backed half of the background-effects feature — the
 * actual segmentation + canvas compositing. Deliberately dynamic-
 * imported (see applyBackgroundEffect in the room page) rather than
 * statically imported at the top of any page: @mediapipe/tasks-vision is
 * a real, sizeable dependency, and pulling it into a page's static
 * module graph means every build has to analyze/bundle it whether or not
 * anyone ever opens the Background panel. The lightweight, always-needed
 * parts (the effect type, comparing two effects, the template list) live
 * in backgroundEffectTypes.ts instead, with no MediaPipe import at all.
 *
 * How it works, in short: MediaPipe's selfie segmentation model runs on
 * every video frame and returns a per-pixel person-vs-background signal.
 * Each frame is drawn twice onto an output canvas — once as the
 * background layer (blurred, or replaced with a flat/gradient fill),
 * then the sharp original video again but clipped to only the person,
 * using the mask as an alpha channel. `canvas.captureStream()` turns
 * that composited canvas into a normal MediaStreamTrack that can replace
 * the camera track everywhere it's used (local preview, every peer
 * connection) — see applyBackgroundEffect in the room page.
 *
 * On mask polarity: three earlier versions of this file each trusted a
 * different piece of official-looking documentation about what this
 * model's mask output means (confidenceMasks index 0 = person; then
 * index 1 = person; then categoryMask value 1 = person) and each one
 * was wrong in a different way for this actual model/API version in
 * practice — including one that turned out to have no usable second
 * channel at all. Rather than trust a fourth documentation claim, this
 * version doesn't assume a polarity at all: it calibrates it empirically
 * per session by sampling the frame center (reliably more likely to be a
 * face, in any webcam video call) against the four corners (reliably
 * more likely to be background) and using whichever the data itself
 * shows to be more "person-like" — see calibratePolarity. This can't be
 * wrong about this model's specific convention because it never assumes
 * one.
 *
 * Model/API URLs were verified against a real working reference
 * implementation (AWS IVS's background-replacement guide, which uses
 * this exact model) before writing this, not just recalled from memory.
 */
import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from "@mediapipe/tasks-vision";
import type { BackgroundEffect } from "./backgroundEffectTypes";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.2/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// Loaded once per page load and reused across starts/stops — creating a
// new ImageSegmenter is a real (network + WASM init) cost, and only one
// is ever needed at a time since a person has exactly one camera track.
let segmenterPromise: Promise<ImageSegmenter> | null = null;
function loadSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    })().catch((err) => {
      // Don't cache a failure — a transient network hiccup loading the
      // WASM/model shouldn't permanently disable the feature for the
      // rest of the session; the next attempt gets a fresh try.
      segmenterPromise = null;
      throw err;
    });
  }
  return segmenterPromise;
}

// Recalibrate periodically, not just once — cheap (a handful of pixel
// samples), and self-corrects if the very first calibration happened to
// land on an unrepresentative frame (person mid-blink, camera still
// focusing, etc.) instead of committing to a bad read for the whole call.
const RECALIBRATE_EVERY_N_FRAMES = 90;

export class VirtualBackgroundProcessor {
  private readonly sourceTrack: MediaStreamTrack;
  private readonly videoEl: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private readonly alphaCanvas: HTMLCanvasElement;
  private readonly alphaCtx: CanvasRenderingContext2D;
  private effect: BackgroundEffect = { type: "none" };
  private timerId: number | null = null;
  private running = false;
  private outputTrack: MediaStreamTrack | null = null;
  private canvasStream: MediaStream | null = null;
  private gradientCache: { key: string; gradient: CanvasGradient } | null = null;
  // null = not yet calibrated. true = high mask values mean "person".
  // false = high mask values mean "background" (invert when reading).
  private personIsHighValue: boolean | null = null;
  private framesSinceCalibration = 0;
  // Reused every frame by isolatePrimarySubject (flood fill) — allocated
  // once at start(), not per frame, since a fresh ~2MB typed array 30
  // times a second is real, avoidable GC pressure.
  private floodVisited: Uint8Array | null = null;
  private floodQueue: Int32Array | null = null;

  constructor(sourceTrack: MediaStreamTrack) {
    this.sourceTrack = sourceTrack;
    this.videoEl = document.createElement("video");
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.videoEl.srcObject = new MediaStream([sourceTrack]);

    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.maskCanvas = document.createElement("canvas");
    const maskCtx = this.maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!maskCtx) throw new Error("2D canvas context unavailable");
    this.maskCtx = maskCtx;

    this.alphaCanvas = document.createElement("canvas");
    const alphaCtx = this.alphaCanvas.getContext("2d", { willReadFrequently: true });
    if (!alphaCtx) throw new Error("2D canvas context unavailable");
    this.alphaCtx = alphaCtx;
  }

  /** Starts the processing loop (if not already running) and returns the
   *  composited output track. Safe to call again with a different effect
   *  while already running — that just updates what's drawn, no restart. */
  async start(effect: BackgroundEffect): Promise<MediaStreamTrack> {
    this.effect = effect;

    if (!this.running) {
      await this.videoEl.play();
      const settings = this.sourceTrack.getSettings();
      const width = settings.width ?? 960;
      const height = settings.height ?? 540;
      this.canvas.width = width;
      this.canvas.height = height;
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.alphaCanvas.width = width;
      this.alphaCanvas.height = height;

      this.canvasStream = this.canvas.captureStream(30);
      this.outputTrack = this.canvasStream.getVideoTracks()[0];
      this.floodVisited = new Uint8Array(width * height);
      this.floodQueue = new Int32Array(width * height);

      this.running = true;
      this.personIsHighValue = null;
      this.framesSinceCalibration = 0;
      const segmenter = await loadSegmenter();
      this.loop(segmenter);
    }

    return this.outputTrack!;
  }

  /** Switches what's drawn without touching the running loop or output
   *  track — used when the person picks a different effect mid-call. */
  setEffect(effect: BackgroundEffect) {
    this.effect = effect;
  }

  stop() {
    this.running = false;
    if (this.timerId !== null) cancelAnimationFrame(this.timerId);
    this.timerId = null;
    this.canvasStream?.getTracks().forEach((t) => t.stop());
    this.canvasStream = null;
    this.outputTrack = null;
    this.videoEl.pause();
    this.videoEl.srcObject = null;
  }

  private loop(segmenter: ImageSegmenter) {
    if (!this.running) return;
    if (this.videoEl.readyState >= 2) {
      const now = performance.now();
      try {
        segmenter.segmentForVideo(this.videoEl, now, (result) => this.render(result));
      } catch {
        // A single bad frame (e.g. a momentary resolution change) isn't
        // worth tearing the whole effect down for — draw the raw frame
        // this tick and let the next one retry segmentation normally.
        this.ctx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
      }
    }
    this.timerId = requestAnimationFrame(() => this.loop(segmenter));
  }

  private getGradient(colors: [string, string]): CanvasGradient {
    const key = colors.join("|");
    if (this.gradientCache?.key === key) return this.gradientCache.gradient;
    const g = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    g.addColorStop(0, colors[0]);
    g.addColorStop(1, colors[1]);
    this.gradientCache = { key, gradient: g };
    return g;
  }

  /** Figures out, from the actual mask data, whether high values mean
   *  "person" or "background" — by comparing the average value in a
   *  small box at the frame's center (reliably more likely to be a face
   *  in any webcam call) against the average across the four corners
   *  (reliably more likely to be background). Whichever region reads
   *  higher is "person". This works regardless of whatever convention
   *  MediaPipe actually uses for this model, since it never assumes one. */
  private calibratePolarity(maskData: Float32Array, w: number, h: number) {
    const boxSize = Math.max(4, Math.round(Math.min(w, h) * 0.12));
    const sampleBox = (cx: number, cy: number): number => {
      let sum = 0;
      let count = 0;
      const half = Math.floor(boxSize / 2);
      const y0 = Math.max(0, cy - half);
      const y1 = Math.min(h, cy + half);
      const x0 = Math.max(0, cx - half);
      const x1 = Math.min(w, cx + half);
      for (let y = y0; y < y1; y++) {
        const rowStart = y * w;
        for (let x = x0; x < x1; x++) {
          sum += maskData[rowStart + x];
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };

    const centerAvg = sampleBox(Math.round(w / 2), Math.round(h / 2));
    const cornerAvg =
      (sampleBox(boxSize, boxSize) +
        sampleBox(w - boxSize, boxSize) +
        sampleBox(boxSize, h - boxSize) +
        sampleBox(w - boxSize, h - boxSize)) /
      4;

    this.personIsHighValue = centerAvg >= cornerAvg;
    this.framesSinceCalibration = 0;
  }

  /**
   * Zeroes out any "person" region the model detected that ISN'T
   * connected to the frame's center — i.e. anyone else visible in
   * frame besides the primary subject. Without this, a person visible
   * in the background stays sharp right along with the primary subject,
   * since MediaPipe's selfie segmenter classifies any person-shaped
   * region, not just the closest/primary one — the room blurs
   * correctly, but a second person in frame doesn't, which reads as
   * broken rather than as a real depth-of-field effect.
   *
   * Implementation: a flood fill (BFS) seeded from a small box at the
   * frame's center — the same "center is reliably the primary subject"
   * assumption calibratePolarity already relies on — that spreads only
   * through 4-connected pixels the model also calls "person". Anything
   * reachable that way keeps its real, confidence-graded value
   * (preserving smooth edges); anything else is forced to 0 regardless
   * of what the model said about those pixels individually. Buffers are
   * pre-allocated in start() and reused here, not allocated per frame.
   */
  private isolatePrimarySubject(personConfidence: Float32Array, w: number, h: number): Float32Array {
    const visited = this.floodVisited;
    const queue = this.floodQueue;
    if (!visited || !queue) return personConfidence;

    const threshold = 0.5;
    visited.fill(0);
    let qHead = 0;
    let qTail = 0;

    const seedRadius = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    for (let y = Math.max(0, cy - seedRadius); y <= Math.min(h - 1, cy + seedRadius); y++) {
      const rowStart = y * w;
      for (let x = Math.max(0, cx - seedRadius); x <= Math.min(w - 1, cx + seedRadius); x++) {
        const idx = rowStart + x;
        if (!visited[idx] && personConfidence[idx] >= threshold) {
          visited[idx] = 1;
          queue[qTail++] = idx;
        }
      }
    }

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0) {
        const n = idx - 1;
        if (!visited[n] && personConfidence[n] >= threshold) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (!visited[n] && personConfidence[n] >= threshold) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (!visited[n] && personConfidence[n] >= threshold) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (!visited[n] && personConfidence[n] >= threshold) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
    }

    const isolated = new Float32Array(personConfidence.length);
    for (let i = 0; i < visited.length; i++) {
      if (visited[i]) isolated[i] = personConfidence[i];
    }
    return isolated;
  }

  private render(result: ImageSegmenterResult) {
    const { ctx, canvas, videoEl, effect } = this;
    const w = canvas.width;
    const h = canvas.height;
    const mask = result.confidenceMasks?.[0];

    if (!mask || effect.type === "none") {
      ctx.drawImage(videoEl, 0, 0, w, h);
      return;
    }

    const maskData = mask.getAsFloat32Array();

    if (this.personIsHighValue === null || this.framesSinceCalibration >= RECALIBRATE_EVERY_N_FRAMES) {
      this.calibratePolarity(maskData, w, h);
    }
    this.framesSinceCalibration++;

    // Background layer. Slightly less aggressive than the first version
    // (14px) — reduces how jarring the contrast against the (now
    // feathered, see below) foreground edge reads.
    if (effect.type === "blur") {
      ctx.filter = "blur(10px)";
      ctx.drawImage(videoEl, 0, 0, w, h);
      ctx.filter = "none";
    } else {
      ctx.fillStyle = this.getGradient(effect.colors);
      ctx.fillRect(0, 0, w, h);
    }

    // Build the raw per-pixel alpha mask on its own canvas — no video
    // content here, just a white fill with alpha = person-confidence, so
    // it can be blurred as a pure alpha shape without blurring any pixel
    // content (RGB is irrelevant to destination-in below; only the
    // alpha channel is used).
    const invert = !this.personIsHighValue;
    const personConfidence = new Float32Array(maskData.length);
    for (let i = 0; i < maskData.length; i++) {
      personConfidence[i] = invert ? 1 - maskData[i] : maskData[i];
    }
    // Drops anyone in frame who isn't the primary (centered) subject —
    // see isolatePrimarySubject's own comment for why this is needed at
    // all: the model detects any person-shaped region, not just the one
    // actually using the call.
    const isolated = this.isolatePrimarySubject(personConfidence, w, h);

    const alphaFrame = this.alphaCtx.createImageData(w, h);
    const alphaPixels = alphaFrame.data;
    for (let i = 0; i < isolated.length; i++) {
      const idx = i * 4;
      alphaPixels[idx] = 255;
      alphaPixels[idx + 1] = 255;
      alphaPixels[idx + 2] = 255;
      alphaPixels[idx + 3] = Math.round(isolated[i] * 255);
    }
    this.alphaCtx.putImageData(alphaFrame, 0, 0);

    // Foreground layer: sharp video, clipped by the alpha mask — but the
    // mask is drawn here through a blur filter, which feathers its edges
    // (a soft gradient between "fully person" and "fully background")
    // instead of the hard, single-pixel-wide cutoff a raw per-pixel alpha
    // copy produces. That feathered edge is what actually reads as
    // natural depth-of-field rather than a sticker pasted over a photo —
    // the blur radius alone (above) was never the real issue.
    this.maskCtx.clearRect(0, 0, w, h);
    this.maskCtx.globalCompositeOperation = "source-over";
    this.maskCtx.drawImage(videoEl, 0, 0, w, h);
    this.maskCtx.globalCompositeOperation = "destination-in";
    this.maskCtx.filter = "blur(3px)";
    this.maskCtx.drawImage(this.alphaCanvas, 0, 0, w, h);
    this.maskCtx.filter = "none";
    this.maskCtx.globalCompositeOperation = "source-over";

    ctx.drawImage(this.maskCanvas, 0, 0);
  }
}
