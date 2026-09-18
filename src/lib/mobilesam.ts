/**
 * MobileSAM (github.com/ChaoningZhang/MobileSAM) running fully in the browser
 * via onnxruntime-web. Encoder + prompt decoder are ONNX exports hosted on the
 * project CDN. This module must only be imported from client-side code.
 */
import * as ort from "onnxruntime-web";
import encoderAsset from "@/assets/models/encoder.onnx.asset.json";
import decoderAsset from "@/assets/models/decoder.onnx.asset.json";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const MODEL_SIZE = 1024;

export type Point = { x: number; y: number; label: 0 | 1 };

export type EncodedImage = {
  embeddings: ort.Tensor;
  width: number;
  height: number;
  scale: number;
};

let sessions: Promise<{ encoder: ort.InferenceSession; decoder: ort.InferenceSession }> | null =
  null;

async function fetchModel(url: string, onProgress?: (loaded: number, total: number) => void) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to load model (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function loadModel(onProgress?: (fraction: number) => void) {
  if (!sessions) {
    sessions = (async () => {
      const encoderBytes = 28_157_093;
      const decoderBytes = 16_501_323;
      const totalBytes = encoderBytes + decoderBytes;
      let encLoaded = 0;
      let decLoaded = 0;
      const report = () => onProgress?.(Math.min(1, (encLoaded + decLoaded) / totalBytes));

      const [encData, decData] = await Promise.all([
        fetchModel(encoderAsset.url, (l) => {
          encLoaded = l;
          report();
        }),
        fetchModel(decoderAsset.url, (l) => {
          decLoaded = l;
          report();
        }),
      ]);

      const opts: ort.InferenceSession.SessionOptions = {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      };
      const [encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(encData, opts),
        ort.InferenceSession.create(decData, opts),
      ]);
      onProgress?.(1);
      return { encoder, decoder };
    })().catch((err) => {
      sessions = null;
      throw err;
    });
  }
  return sessions;
}

/** Runs the image encoder once per image. Coordinates stay in original pixels. */
export async function encodeImage(source: HTMLCanvasElement): Promise<EncodedImage> {
  const { encoder } = await loadModel();
  const width = source.width;
  const height = source.height;
  const scale = MODEL_SIZE / Math.max(width, height);
  const rw = Math.round(width * scale);
  const rh = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, rw, rh);
  const { data } = ctx.getImageData(0, 0, rw, rh);

  const input = new Float32Array(rh * rw * 3);
  for (let i = 0, p = 0; i < data.length; i += 4) {
    input[p++] = data[i]!;
    input[p++] = data[i + 1]!;
    input[p++] = data[i + 2]!;
  }

  const result = await encoder.run({
    input_image: new ort.Tensor("float32", input, [rh, rw, 3]),
  });
  return { embeddings: result["image_embeddings"]!, width, height, scale };
}

/** Returns a binary mask (1 byte per pixel) at the original image resolution. */
export async function segment(image: EncodedImage, points: Point[]): Promise<Uint8Array> {
  const { decoder } = await loadModel();
  const n = points.length;
  const coords = new Float32Array((n + 1) * 2);
  const labels = new Float32Array(n + 1);
  points.forEach((pt, i) => {
    coords[i * 2] = pt.x * image.scale;
    coords[i * 2 + 1] = pt.y * image.scale;
    labels[i] = pt.label;
  });
  // SAM requires a padding point when no box prompt is supplied.
  coords[n * 2] = 0;
  coords[n * 2 + 1] = 0;
  labels[n] = -1;

  const output = await decoder.run({
    image_embeddings: image.embeddings,
    point_coords: new ort.Tensor("float32", coords, [1, n + 1, 2]),
    point_labels: new ort.Tensor("float32", labels, [1, n + 1]),
    mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor("float32", new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor("float32", new Float32Array([image.height, image.width]), [2]),
  });

  const masks = output["masks"]!;
  const logits = masks.data as Float32Array;
  const pixels = image.width * image.height;
  const mask = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) mask[i] = logits[i]! > 0 ? 1 : 0;
  return mask;
}

export type Cutout = {
  dataUrl: string;
  width: number;
  height: number;
  coverage: number;
};

/** Crops the masked pixels of `source` into a tightly-cropped transparent PNG. */
export function maskToCutout(
  source: HTMLCanvasElement,
  mask: Uint8Array,
  feather = true,
): Cutout | null {
  const w = source.width;
  const h = source.height;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || count < 16) return null;

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const src = source.getContext("2d")!.getImageData(minX, minY, cw, ch);
  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const mi = (y + minY) * w + (x + minX);
      const i = (y * cw + x) * 4;
      out.data[i] = src.data[i]!;
      out.data[i + 1] = src.data[i + 1]!;
      out.data[i + 2] = src.data[i + 2]!;
      let alpha = mask[mi] ? 255 : 0;
      if (feather && alpha === 255) {
        // Soften the very edge of the mask by one pixel.
        const edge =
          !mask[mi - 1] || !mask[mi + 1] || !mask[mi - w] || !mask[mi + w] ? true : false;
        if (edge) alpha = 190;
      }
      out.data[i + 3] = alpha;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext("2d")!.putImageData(out, 0, 0);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: cw,
    height: ch,
    coverage: count / (w * h),
  };
}

/** Loads a user file into a canvas, downscaling very large images. */
export async function fileToCanvas(file: File, maxSide = 1600): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}
