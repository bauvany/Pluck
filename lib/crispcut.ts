/**
 * Background removal via BiRefNet_lite-512 (ZhengPeng7/BiRefNet_lite,
 * browser-ready 512×512 ONNX re-export by studioludens). Runs fully
 * in-browser. MIT-licensed — no non-commercial restriction.
 *
 * Two execution paths, same model:
 *
 * - **WebGPU** (Chrome/Edge 113+, Safari 17+): fp16 weights (~94 MB). Fast
 *   GPU inference.
 * - **WASM fallback**: fp32 weights (~183 MB). Needed because several
 *   fp16 operators lack WASM kernels. Slower but works everywhere.
 *
 * The 512×512 input (vs BiRefNet's native 1024) is what makes browser
 * inference possible — the 1024 variants OOM the WASM heap and exceed
 * WebGPU's storage-buffer limits. Edge detail is slightly softer than 1024
 * but indistinguishable in practice.
 *
 * Output is raw logits — sigmoid must be applied externally to get the
 * alpha matte in [0, 1].
 */
import * as ort from "onnxruntime-web/webgpu";
import { fetchCached } from "./model-cache";

const MODEL_FP16_URL =
  "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx";
const MODEL_FP32_URL =
  "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx";

// BiRefNet preprocessing: 512×512, ImageNet normalization, rescale 1/255.
const MODEL_SIZE = 512;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Backend = "webgpu" | "wasm";
type SessionInfo = { session: ort.InferenceSession; backend: Backend };

let sessionInfo: Promise<SessionInfo> | null = null;

/** True if the current browser can mount a WebGPU device. */
async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function loadCrispcut(
  onProgress?: (loaded: number, total: number) => void,
  onSource?: (source: "cache" | "network") => void,
): Promise<ort.InferenceSession> {
  return getOrLoadSession(onProgress, onSource).then((info) => info.session);
}

async function getOrLoadSession(
  onProgress?: (loaded: number, total: number) => void,
  onSource?: (source: "cache" | "network") => void,
): Promise<SessionInfo> {
  if (sessionInfo) return sessionInfo;

  const load = async (): Promise<SessionInfo> => {
    // Prefer WebGPU + fp16 for speed and smaller download; fall back to
    // WASM + fp32 (fp16 lacks some WASM kernels per onnxruntime-web).
    const useWebGPU = await hasWebGPU();
    if (useWebGPU) {
      try {
        const buffer = await fetchCached(MODEL_FP16_URL, onProgress, onSource);
        const session = await ort.InferenceSession.create(buffer, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
          logSeverityLevel: 3,
        });
        return { session, backend: "webgpu" as const };
      } catch (err) {
        console.warn("[crispcut] WebGPU session failed, falling back to WASM:", err);
      }
    }

    const buffer = await fetchCached(MODEL_FP32_URL, onProgress, onSource);
    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    return { session, backend: "wasm" as const };
  };

  sessionInfo = load().catch((err) => {
    sessionInfo = null;
    throw err;
  });
  return sessionInfo;
}

/** Which backend the active session is using, so callers can report
 *  the right download size to the user. */
export async function getActiveBackend(): Promise<Backend | null> {
  if (!sessionInfo) return null;
  try {
    const info = await sessionInfo;
    return info.backend;
  } catch {
    return null;
  }
}

/**
 * Runs BiRefNet_lite on the given canvas and returns a soft alpha mask
 * (0-255) at the canvas's original resolution.
 */
export async function removeBackground(source: HTMLCanvasElement): Promise<Uint8Array> {
  const { session } = await getOrLoadSession();
  const w = source.width;
  const h = source.height;

  // Resize to 512×512 (stretch, no letterbox).
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const { data } = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

  // Normalise to NCHW float32 with ImageNet mean/std (rescale 1/255 baked in).
  const plane = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    input[px] = (data[i]! / 255 - MEAN[0]!) / STD[0]!;
    input[plane + px] = (data[i + 1]! / 255 - MEAN[1]!) / STD[1]!;
    input[2 * plane + px] = (data[i + 2]! / 255 - MEAN[2]!) / STD[2]!;
  }

  const output = await session.run({
    input_image: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });

  // BiRefNet outputs raw logits — apply sigmoid to get the alpha matte.
  // Output name varies by export; grab the first output tensor.
  const outputName = session.outputNames[0]!;
  const raw = output[outputName]!.data as Float32Array;

  // Build a MODEL_SIZE alpha mask (grayscale, soft edges preserved).
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MODEL_SIZE;
  maskCanvas.height = MODEL_SIZE;
  const maskCtx = maskCanvas.getContext("2d")!;
  const maskData = maskCtx.createImageData(MODEL_SIZE, MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    // sigmoid(x) = 1 / (1 + e^-x)
    const sigmoid = 1 / (1 + Math.exp(-raw[i]!));
    const v = Math.round(sigmoid * 255);
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
