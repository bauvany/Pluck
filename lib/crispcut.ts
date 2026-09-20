/**
 * RMBG-1.4 — high-quality general-purpose background removal by BRIA AI.
 * Full-precision fp32 ONNX (~176MB) for maximum edge quality — the int8
 * quantized variant loses fine detail. 1024×1024 input.
 * Loaded directly from HuggingFace CDN. Client-side only.
 */
import * as ort from "onnxruntime-web";
import { fetchCached } from "./model-cache";

const MODEL_URL =
  "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx";

// RMBG-1.4 preprocessing: 1024×1024, mean=[0.5,0.5,0.5], std=[1,1,1].
const MODEL_SIZE = 1024;
const MEAN = [0.5, 0.5, 0.5];
const STD = [1, 1, 1];

let session: Promise<ort.InferenceSession> | null = null;

export function loadCrispcut(
  onProgress?: (loaded: number, total: number) => void,
  onSource?: (source: "cache" | "network") => void,
): Promise<ort.InferenceSession> {
  if (!session) {
    session = (async () => {
      const buffer = await fetchCached(MODEL_URL, onProgress, onSource);
      const s = await ort.InferenceSession.create(buffer, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        logSeverityLevel: 3, // suppress warnings — only show errors
      });
      return s;
    })().catch((err) => {
      session = null;
      throw err;
    });
  }
  return session;
}

/**
 * Runs RMBG-1.4 on the given canvas and returns a soft alpha mask (0-255)
 * at the canvas's original resolution.
 */
export async function removeBackground(source: HTMLCanvasElement): Promise<Uint8Array> {
  const sess = await loadCrispcut();
  const w = source.width;
  const h = source.height;

  // Model expects a plain resize to 1024×1024 (stretch, no letterbox).
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const { data } = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

  // Normalise to NCHW float32 (channel-PLANES, not interleaved) with mean/std.
  const plane = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    input[px] = (data[i]! / 255 - MEAN[0]!) / STD[0]!;
    input[plane + px] = (data[i + 1]! / 255 - MEAN[1]!) / STD[1]!;
    input[2 * plane + px] = (data[i + 2]! / 255 - MEAN[2]!) / STD[2]!;
  }

  const inputName = sess.inputNames[0]!;
  const output = await sess.run({
    [inputName]: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });

  // The ONNX graph already applies the final sigmoid — the output is an
  // alpha matte. BRIA's reference post-processing min-max normalises it to
  // stretch contrast (applying sigmoid again would compress everything into
  // mid-range alpha and make the whole image semi-transparent).
  const outputName = sess.outputNames[0]!;
  const raw = output[outputName]!.data as Float32Array;
  let ma = -Infinity;
  let mi = Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (v > ma) ma = v;
    if (v < mi) mi = v;
  }
  const range = ma - mi || 1;

  // Build a MODEL_SIZE alpha mask (grayscale, soft edges preserved).
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MODEL_SIZE;
  maskCanvas.height = MODEL_SIZE;
  const maskCtx = maskCanvas.getContext("2d")!;
  const maskData = maskCtx.createImageData(MODEL_SIZE, MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    const alpha = (raw[i]! - mi) / range;
    const v = Math.round(alpha * 255);
    maskData.data[i * 4] = v;
    maskData.data[i * 4 + 1] = v;
    maskData.data[i * 4 + 2] = v;
    maskData.data[i * 4 + 3] = 255;
  }
  maskCtx.putImageData(maskData, 0, 0);

  // Resize the mask back to the original dimensions.
  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d")!;
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(maskCanvas, 0, 0, w, h);
  const outData = outCtx.getImageData(0, 0, w, h).data;

  // Return a soft mask (0-255 alpha values) for better edge quality.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    mask[i] = outData[i * 4]!;
  }
  return mask;
}
