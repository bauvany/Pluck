/**
 * Persistent model cache using the browser Cache API.
 * Models are large ONNX files that don't change — caching them avoids
 * re-downloading ~50MB on every page reload.
 */

const CACHE_NAME = "onnx-models-v3";

/**
 * Fetches a URL with progress reporting, caching the result for subsequent loads.
 * On cache hit, resolves instantly (progress jumps to 100%).
 */
export async function fetchCached(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  // Try cache first.
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        const buffer = new Uint8Array(await cached.arrayBuffer());
        onProgress?.(buffer.byteLength, buffer.byteLength);
        return buffer;
      }
    } catch {
      // Cache unavailable (private mode etc.) — fall through to network.
    }
  }

  // Network fetch with streaming progress.
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

  // Store in cache for next load.
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const response = new Response(out, {
        headers: { "content-type": "application/octet-stream" },
      });
      await cache.put(url, response);
    } catch {
      // Ignore cache write failures.
    }
  }

  return out;
}
