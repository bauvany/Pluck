/**
 * RMBG-1.4 — high-quality general-purpose background removal by BRIA AI.
 * ~44MB int8-quantized ONNX, 1024×1024 input, excellent on photos.
 * Loaded directly from HuggingFace CDN.
 * Client-side only.
 */
import * as ort from "onnxruntime-web";
import { fetchCached } from "./model-cache";

const MODEL_URL =
  "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx";

// RMBG-1.4 preprocessing: 1024×1024, mean=[0.5,0.5,0.5], std=[1,1,1].
const MODEL_SIZE = 1024;
const MEAN = [0.5, 0.5, 0.5];
const STD = [1, 1, 1];

let session: Promise<ort.InferenceSession> | null = null;

export function loadCrispcut(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ort.InferenceSession> {
  if (!session) {
    session = (async () => {
      const buffer = await fetchCached(MODEL_URL, onProgress);
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

  // Normalise to NCHW float32 with mean/std and 1/255 rescale.
  const input = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let i = 0, p = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      input[p++] = (data[i + c]! / 255 - MEAN[c]!) / STD[c]!;
    }
  }

  const inputName = sess.inputNames[0]!;
  const output = await sess.run({
    [inputName]: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });

  // Output is logits — apply sigmoid to get alpha matte in [0, 1].
  const outputName = sess.outputNames[0]!;
  const logits = output[outputName]!.data as Float32Array;

  // Build a MODEL_SIZE alpha mask (grayscale, soft edges preserved).
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MODEL_SIZE;
  maskCanvas.height = MODEL_SIZE;
  const maskCtx = maskCanvas.getContext("2d")!;
  const maskData = maskCtx.createImageData(MODEL_SIZE, MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    const alpha = 1 / (1 + Math.exp(-logits[i]!));
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
