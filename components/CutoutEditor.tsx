import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUUpLeft,
  ArrowUUpRight,
  Download,
  Eraser,
  Eyedropper,
  MagicWand,
  Palette,
  Plus,
  Spinner,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  canvasToCutout,
  clipMaskToPolygon,
  encodeImage,
  fileToCanvas,
  loadModel,
  maskToCutout,
  segment,
  type Cutout,
  type EncodedImage,
  type Point,
} from "@/lib/mobilesam";
import { removeBackground as crispcutRemoveBg, loadCrispcut } from "@/lib/crispcut";
import { idbGet, idbPut } from "@/lib/idb";

type Part = Cutout & { id: string; name: string };

type Snapshot = {
  points: Point[];
  canvasData: ImageData | null;
};

/** Paints a filled circle into a binary mask (manual brush stamp). */
function stampBrush(
  mask: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 1,
) {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value;
    }
  }
}

/** Samples up to `maxPoints` evenly-spread points from a painted stroke mask. */
function sampleStrokePoints(
  stroke: Uint8Array,
  w: number,
  h: number,
  label: 0 | 1,
  maxPoints = 24,
): Point[] {
  const pts: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (stroke[y * w + x]) pts.push({ x, y });
    }
  }
  if (pts.length === 0) return [];
  const stride = Math.max(1, Math.floor(pts.length / maxPoints));
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i += stride) {
    out.push({ x: pts[i]!.x + 0.5, y: pts[i]!.y + 0.5, label });
  }
  return out;
}

export default function CutoutEditor() {
  const baseCanvas = useRef<HTMLCanvasElement | null>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const encodedRef = useRef<EncodedImage | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);

  const [ready, setReady] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [status, setStatus] = useState("Loading up models…");
  const [busy, setBusy] = useState(false);
  const [removingBg, setRemovingBg] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate saved session (parts + points) from IndexedDB before persisting.
  useEffect(() => {
    void (async () => {
      try {
        const [savedParts, savedPoints] = await Promise.all([
          idbGet<Part[]>("parts"),
          idbGet<Point[]>("points"),
        ]);
        if (savedParts) setParts(savedParts);
        if (savedPoints) setPoints(savedPoints);
      } catch {
        // Start fresh.
      }
      setHydrated(true);
    })();
  }, []);

  // Persist parts across reloads (only after hydration to avoid wiping saved data).
  useEffect(() => {
    if (!hydrated) return;
    void idbPut("parts", parts);
  }, [parts, hydrated]);

  // Persist selection points across reloads.
  useEffect(() => {
    if (!hydrated) return;
    void idbPut("points", points);
  }, [points, hydrated]);

  // Persist the base image (captures bg removal / cut state) to IndexedDB.
  const persistImage = useCallback(() => {
    const base = baseCanvas.current;
    if (!base) return;
    base.toBlob((blob) => {
      if (blob) void idbPut("image", blob);
    }, "image/png");
  }, []);
  const [mode, setMode] = useState<"mask" | "exclude" | "cut">("mask");
  const [paintMode, setPaintMode] = useState<"auto" | "manual">("auto");
  const [brushSize, setBrushSize] = useState(8);
  const [tool, setTool] = useState<"none" | "chroma" | "picker">("none");
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  const toolActive = tool !== "none";
  const manualPaintingRef = useRef(false);
  const lastStampRef = useRef<{ x: number; y: number } | null>(null);
  const strokeMaskRef = useRef<Uint8Array | null>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isDrawingRef = useRef(false);
  const dragOccurredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let sources: ("cache" | "network")[] = [];
    const track = (s: "cache" | "network") => {
      sources.push(s);
      if (!cancelled) {
        setStatus(
          sources.includes("network")
            ? "Downloading models (cached for next time)…"
            : "Loading cached models…",
        );
      }
    };
    // MobileSAM loads eagerly (needed for clicks). The background-removal
    // model is lazy-loaded on first "Remove background" press.
    loadModel(undefined, track)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setModelsLoaded(true);
        setStatus("Upload an image, then click a part to cut it out.");
      })
      .catch((err: Error) => setStatus(`Couldn't load the models: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const paintOverlay = useCallback((mask: Uint8Array | null, pts: Point[]) => {
    const base = baseCanvas.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const ctx = overlay.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (mask) {
      const img = new ImageData(overlay.width, overlay.height);
      // Theme color from the single CSS variable (fallback: #FFCCBB).
      const raw =
        getComputedStyle(document.documentElement).getPropertyValue("--theme-primary").trim() ||
        "#FFCCBB";
      const hex = raw.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const j = i * 4;
        img.data[j] = r;
        img.data[j + 1] = g;
        img.data[j + 2] = b;
        img.data[j + 3] = 110;
      }
      ctx.putImageData(img, 0, 0);
    }
  }, []);

  // Undo/redo history — index tracked in a ref to avoid stale closures.
  const historyRef = useRef<Snapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current >= 0 && historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const snapshotCanvas = useCallback((): ImageData | null => {
    const base = baseCanvas.current;
    if (!base) return null;
    return base.getContext("2d")!.getImageData(0, 0, base.width, base.height);
  }, []);

  const pushHistory = useCallback(
    (snap: Snapshot) => {
      // Truncate any redo history if we're not at the end.
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
      historyRef.current.push(snap);
      historyIndexRef.current = historyRef.current.length - 1;
      updateHistoryFlags();
    },
    [updateHistoryFlags],
  );

  const runSegment = useCallback(
    async (pts: Point[], clipPolygon?: { x: number; y: number }[]) => {
      const encoded = encodedRef.current;
      if (!encoded || pts.length === 0) {
        maskRef.current = null;
        paintOverlay(null, pts);
        return;
      }
      setBusy(true);
      setStatus("Finding that part…");
      try {
        let mask = await segment(encoded, pts);
        if (clipPolygon && clipPolygon.length >= 3) {
          mask = clipMaskToPolygon(mask, baseCanvas.current!.width, baseCanvas.current!.height, clipPolygon);
        }
        maskRef.current = mask;
        paintOverlay(mask, pts);
        setStatus("Looks right? Add it as a part, or click again to refine.");
      } catch (err) {
        setStatus(`Selection failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [paintOverlay],
  );

  // Restore the last session's image + selection once models are ready.
  useEffect(() => {
    if (!ready || !hydrated) return;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await idbGet<Blob>("image");
        if (!blob || cancelled) return;
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (cancelled) return;
        // Load the pristine copy for Reset.
        const origBlob = await idbGet<Blob>("original");
        if (origBlob && !cancelled) {
          const ob = await createImageBitmap(origBlob);
          const oc = document.createElement("canvas");
          oc.width = ob.width;
          oc.height = ob.height;
          oc.getContext("2d")!.drawImage(ob, 0, 0);
          ob.close();
          originalCanvasRef.current = oc;
        }
        baseCanvas.current = canvas;
        setHasImage(true);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const el of [displayRef.current, overlayRef.current]) {
          if (!el) continue;
          el.width = canvas.width;
          el.height = canvas.height;
        }
        displayRef.current?.getContext("2d")!.drawImage(canvas, 0, 0);
        setStatus("Analysing your last image…");
        encodedRef.current = await encodeImage(canvas);
        setImageReady(true);
        historyRef.current = [{ points: [], canvasData: snapshotCanvas() }];
        historyIndexRef.current = 0;
        updateHistoryFlags();
        // Restore saved points (from hydrated state) and re-run segmentation.
        if (points.length > 0) {
          void runSegment(points);
        } else {
          paintOverlay(null, []);
        }
        setStatus("Restored your last session. Click a part to continue.");
      } catch {
        // Restore failed — start fresh.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hydrated]);

  // Cut mode: click → SAM segments → saves as part → removes area from canvas.
  const runCut = useCallback(
    async (pts: Point[]) => {
      const encoded = encodedRef.current;
      const base = baseCanvas.current;
      if (!encoded || !base || pts.length === 0) return;
      setBusy(true);
      setStatus("Cutting that part…");
      try {
        const mask = await segment(encoded, pts);
        // Remove the masked area from the canvas (alpha → 0).
        const ctx = base.getContext("2d")!;
        const imageData = ctx.getImageData(0, 0, base.width, base.height);
        const data = imageData.data;
        for (let i = 0; i < mask.length; i++) {
          if (mask[i]) data[i * 4 + 3] = 0;
        }
        ctx.putImageData(imageData, 0, 0);
        const display = displayRef.current;
        if (display) {
          const dctx = display.getContext("2d")!;
          dctx.clearRect(0, 0, display.width, display.height);
          dctx.drawImage(base, 0, 0);
        }
        setPoints([]);
        maskRef.current = null;
        paintOverlay(null, []);
        pushHistory({ points: [], canvasData: snapshotCanvas() });
        setStatus("Cut out and saved. Click another part.");
        persistImage();
      } catch (err) {
        setStatus(`Cut failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [paintOverlay, pushHistory, snapshotCanvas, persistImage],
  );

  const restoreSnapshot = useCallback(
    (snap: Snapshot) => {
      setPoints(snap.points);
      const base = baseCanvas.current;
      const display = displayRef.current;
      if (base && snap.canvasData) {
        const ctx = base.getContext("2d")!;
        ctx.putImageData(snap.canvasData, 0, 0);
        if (display) {
          const dctx = display.getContext("2d")!;
          dctx.clearRect(0, 0, display.width, display.height);
          dctx.drawImage(base, 0, 0);
        }
      }
      maskRef.current = null;
      if (snap.points.length > 0) {
        // Re-run SAM in the background (no busy state) so clicks work immediately.
        const encoded = encodedRef.current;
        if (encoded) {
          segment(encoded, snap.points)
            .then((mask) => {
              maskRef.current = mask;
              paintOverlay(mask, snap.points);
            })
            .catch(() => paintOverlay(null, snap.points));
        } else {
          paintOverlay(null, snap.points);
        }
      } else {
        paintOverlay(null, []);
      }
    },
    [paintOverlay],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    restoreSnapshot(historyRef.current[historyIndexRef.current]!);
    updateHistoryFlags();
    setStatus("Undid.");
  }, [restoreSnapshot, updateHistoryFlags]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    restoreSnapshot(historyRef.current[historyIndexRef.current]!);
    updateHistoryFlags();
    setStatus("Redid.");
  }, [restoreSnapshot, updateHistoryFlags]);

  // Manual mode: stamps the brush into the mask (or erases the canvas in cut mode).
  const applyManualStamp = useCallback(
    (x: number, y: number) => {
      const base = baseCanvas.current;
      if (!base) return;
      const r = brushSize / 2;
      if (mode === "cut") {
        // Live erase under the brush.
        const ctx = base.getContext("2d")!;
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        const display = displayRef.current;
        if (display) {
          const dctx = display.getContext("2d")!;
          dctx.clearRect(0, 0, display.width, display.height);
          dctx.drawImage(base, 0, 0);
        }
      } else {
        const mask = maskRef.current;
        if (!mask) return;
        stampBrush(mask, base.width, base.height, x, y, r, mode === "exclude" ? 0 : 1);
        paintOverlay(mask, []);
      }
    },
    [brushSize, mode, paintOverlay],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (toolActive) return;
      if (!hasImage || !ready || !imageReady || busy || removingBg) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * e.currentTarget.width;
      const y = ((e.clientY - rect.top) / rect.height) * e.currentTarget.height;
      if (paintMode === "manual") {
        // Manual brush: clicks paint dots, drags paint lines.
        if (mode === "exclude" && !maskRef.current) {
          setStatus("Nothing to exclude yet — paint a mask with the Mask tab first.");
          return;
        }
        const base = baseCanvas.current;
        if (mode !== "cut" && !maskRef.current && base) {
          maskRef.current = new Uint8Array(base.width * base.height);
        }
        dragOccurredRef.current = false;
        manualPaintingRef.current = true;
        lastStampRef.current = { x, y };
        applyManualStamp(x, y);
        return;
      }
      drawStartRef.current = { x, y };
      isDrawingRef.current = false;
      dragOccurredRef.current = false;
    },
    [toolActive, paintMode, mode, applyManualStamp, hasImage, ready, imageReady, busy, removingBg],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * e.currentTarget.width;
      const y = ((e.clientY - rect.top) / rect.height) * e.currentTarget.height;
      if (manualPaintingRef.current) {
        // Interpolate stamps so fast drags don't leave gaps.
        const last = lastStampRef.current;
        if (!last) return;
        const dist = Math.hypot(x - last.x, y - last.y);
        const steps = Math.max(1, Math.ceil(dist / Math.max(1, brushSize / 4)));
        for (let s = 1; s <= steps; s++) {
          applyManualStamp(last.x + ((x - last.x) * s) / steps, last.y + ((y - last.y) * s) / steps);
        }
        lastStampRef.current = { x, y };
        return;
      }
      const start = drawStartRef.current;
      if (!start) return;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!isDrawingRef.current && dx * dx + dy * dy > 25) {
        // Moved more than ~5px — this is a drag, start painting the stroke.
        isDrawingRef.current = true;
        dragOccurredRef.current = true;
        const base = baseCanvas.current;
        if (base && !strokeMaskRef.current) {
          strokeMaskRef.current = new Uint8Array(base.width * base.height);
        }
        lastStampRef.current = { x: start.x, y: start.y };
      }
      if (isDrawingRef.current) {
        // Paint the stroke with the brush thickness into the mask.
        const base = baseCanvas.current;
        const stroke = strokeMaskRef.current;
        if (!base || !stroke) return;
        const last = lastStampRef.current ?? start;
        const r = brushSize / 2;
        const dist = Math.hypot(x - last.x, y - last.y);
        const steps = Math.max(1, Math.ceil(dist / Math.max(1, brushSize / 4)));
        for (let s = 1; s <= steps; s++) {
          const sx = last.x + ((x - last.x) * s) / steps;
          const sy = last.y + ((y - last.y) * s) / steps;
          stampBrush(stroke, base.width, base.height, sx, sy, r, 1);
          if (mode !== "cut" && maskRef.current) {
            stampBrush(maskRef.current, base.width, base.height, sx, sy, r, mode === "exclude" ? 0 : 1);
          }
        }
        lastStampRef.current = { x, y };
        paintOverlay(mode === "cut" ? stroke : maskRef.current, []);
      }
    },
    [brushSize, mode, paintOverlay, applyManualStamp],
  );

  const handlePointerUp = useCallback(() => {
    if (manualPaintingRef.current) {
      manualPaintingRef.current = false;
      lastStampRef.current = null;
      if (mode === "cut") {
        pushHistory({ points, canvasData: snapshotCanvas() });
        persistImage();
        setStatus("Cut out. Keep scrubbing or switch tabs.");
      } else {
        setStatus(
          mode === "mask"
            ? "Painted. Keep painting or add it as a part."
            : "Excluded. Keep painting or add it as a part.",
        );
      }
      return;
    }
    if (!isDrawingRef.current) {
      drawStartRef.current = null;
      return;
    }
    isDrawingRef.current = false;
    drawStartRef.current = null;
    // Sample prompt points from the painted stroke — the stroke area tells
    // SAM what to segment.
    const stroke = strokeMaskRef.current;
    strokeMaskRef.current = null;
    lastStampRef.current = null;
    const base = baseCanvas.current;
    if (!stroke || !base) return;
    const label: 0 | 1 = mode === "exclude" ? 0 : 1;
    const sampled = sampleStrokePoints(stroke, base.width, base.height, label);
    if (sampled.length === 0) {
      setStatus("That stroke was too small — try a bigger brush or a longer stroke.");
      return;
    }
    const next = [...points, ...sampled];
    setPoints(next);
    if (mode === "cut") {
      void runCut(next);
    } else {
      pushHistory({ points: next, canvasData: snapshotCanvas() });
      void runSegment(next);
    }
  }, [points, mode, pushHistory, snapshotCanvas, persistImage, runSegment, runCut]);

  const handleFile = useCallback(
    async (file: File) => {
      setImageReady(false);
      setBusy(true);
      setStatus("Reading your image…");
      try {
        const canvas = await fileToCanvas(file);
        baseCanvas.current = canvas;
        // Keep a pristine copy for Reset.
        const orig = document.createElement("canvas");
        orig.width = canvas.width;
        orig.height = canvas.height;
        orig.getContext("2d")!.drawImage(canvas, 0, 0);
        originalCanvasRef.current = orig;
        orig.toBlob((blob) => {
          if (blob) void idbPut("original", blob);
        }, "image/png");
        setHasImage(true);
        setPoints([]);
        maskRef.current = null;
        // Wait for the canvases to be mounted/laid out before sizing and drawing.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const el of [displayRef.current, overlayRef.current]) {
          if (!el) continue;
          el.width = canvas.width;
          el.height = canvas.height;
        }
        displayRef.current?.getContext("2d")!.drawImage(canvas, 0, 0);
        paintOverlay(null, []);
        setStatus("Analysing the image…");
        encodedRef.current = await encodeImage(canvas);
        setStatus("Click any part: hair, face, a hand, an accessory…");
        setImageReady(true);
        persistImage();
        // Push initial state so undo/redo has a baseline.
        historyRef.current = [{ points: [], canvasData: snapshotCanvas() }];
        historyIndexRef.current = 0;
        updateHistoryFlags();
      } catch (err) {
        console.error("[handleFile] Failed:", err);
        setStatus(`Couldn't open that image: ${(err as Error).message}`);
        // Still show the image even if encoding failed — just without click-to-cut.
        setImageReady(true);
      } finally {
        setBusy(false);
      }
    },
    [paintOverlay, snapshotCanvas, updateHistoryFlags, persistImage],
  );

  const rgbToHex = (r: number, g: number, b: number) =>
    "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

  // Chroma key: removes every pixel matching the clicked color (small tolerance
  // so compression noise doesn't leave speckles).
  const applyChromaKey = (cx: number, cy: number) => {
    const base = baseCanvas.current;
    if (!base) return;
    const ctx = base.getContext("2d")!;
    const imageData = ctx.getImageData(0, 0, base.width, base.height);
    const data = imageData.data;
    const sx = Math.round(cx);
    const sy = Math.round(cy);
    const si = (sy * base.width + sx) * 4;
    const r = data[si]!;
    const g = data[si + 1]!;
    const b = data[si + 2]!;
    const tol = 16;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - r) <= tol &&
        Math.abs(data[i + 1]! - g) <= tol &&
        Math.abs(data[i + 2]! - b) <= tol
      ) {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const display = displayRef.current;
    if (display) {
      const dctx = display.getContext("2d")!;
      dctx.clearRect(0, 0, display.width, display.height);
      dctx.drawImage(base, 0, 0);
    }
    pushHistory({ points, canvasData: snapshotCanvas() });
    persistImage();
    setStatus(`Cut out color ${rgbToHex(r, g, b).toUpperCase()}.`);
  };

  const pickColor = (x: number, y: number) => {
    const base = baseCanvas.current;
    if (!base) return;
    const d = base
      .getContext("2d")!
      .getImageData(Math.round(x), Math.round(y), 1, 1).data;
    setPickedColor(rgbToHex(d[0]!, d[1]!, d[2]!).toUpperCase());
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (paintMode === "manual") return; // pointer handlers already painted
    if (dragOccurredRef.current) {
      // Was a drag (lasso), not a click — suppress.
      dragOccurredRef.current = false;
      return;
    }
    if (!hasImage || !ready || !imageReady || busy || removingBg) return;
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * el.width;
    const y = ((event.clientY - rect.top) / rect.height) * el.height;
    if (tool === "picker") {
      pickColor(x, y);
      return;
    }
    if (tool === "chroma") {
      applyChromaKey(x, y);
      return;
    }
    if (mode === "cut") {
      const label: 0 | 1 = 1;
      const next = [...points, { x, y, label }];
      setPoints(next);
      void runCut(next);
      return;
    }
    if (mode === "exclude") {
      // Exclude only applies over already-masked areas — ignore clicks elsewhere.
      const mask = maskRef.current;
      const px = Math.round(x);
      const py = Math.round(y);
      if (!mask || !mask[Math.round(y) * baseCanvas.current!.width + Math.round(x)]) {
        setStatus("Nothing is highlighted there — switch to Mask to select a part first.");
        return;
      }
      const next = [...points, { x, y, label: 0 as const }];
      setPoints(next);
      pushHistory({ points: next, canvasData: snapshotCanvas() });
      void runSegment(next);
      return;
    }
    const next = [...points, { x, y, label: 1 as const }];
    setPoints(next);
    pushHistory({ points: next, canvasData: snapshotCanvas() });
    void runSegment(next);
  };

  const addPart = () => {
    const base = baseCanvas.current;
    if (!base) {
      setStatus("Upload an image first.");
      return;
    }
    // With a selection, cut out the masked part. Without one, capture the
    // whole image (e.g. after a background removal) so it can be exported.
    const cutout = maskRef.current ? maskToCutout(base, maskRef.current) : canvasToCutout(base);
    if (!cutout) {
      setStatus("That selection was too small — try clicking closer to the middle of the part.");
      return;
    }
    if (!cutout) {
      setStatus("That selection was too small — try clicking closer to the middle of the part.");
      return;
    }
    const newPart = { ...cutout, id: crypto.randomUUID(), name: `part-${parts.length + 1}` };
    setParts([newPart, ...parts]);
    setPoints([]);
    maskRef.current = null;
    paintOverlay(null, []);
    setStatus("Saved. Click another part to keep going.");
  };

  // Reset — restores the pristine uploaded image and clears all edits
  // (points, mask, bg removal, cuts, chroma key). Parts are kept.
  const resetEdits = () => {
    const original = originalCanvasRef.current;
    const base = baseCanvas.current;
    if (!original || !base) return;
    const ctx = base.getContext("2d")!;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.drawImage(original, 0, 0);
    const display = displayRef.current;
    if (display) {
      const dctx = display.getContext("2d")!;
      dctx.clearRect(0, 0, display.width, display.height);
      dctx.drawImage(original, 0, 0);
    }
    setPoints([]);
    maskRef.current = null;
    paintOverlay(null, []);
    historyRef.current = [{ points: [], canvasData: snapshotCanvas() }];
    historyIndexRef.current = 0;
    updateHistoryFlags();
    persistImage();
    setStatus("Edits reset — original image restored.");
  };

  const removeBackground = useCallback(async () => {
    const base = baseCanvas.current;
    if (!base || !ready) return;
    setRemovingBg(true);
    setStatus("Preparing background remover (first run downloads ~176MB)…");
    try {
      const mask = await crispcutRemoveBg(base);
      setStatus("Removing background…");
      const ctx = base.getContext("2d")!;
      const imageData = ctx.getImageData(0, 0, base.width, base.height);
      const data = imageData.data;
      // RMBG-1.4 returns a soft foreground alpha (0-255) — multiply existing
      // alpha so earlier edits (cuts, chroma key) stay transparent.
      for (let i = 0; i < mask.length; i++) {
        data[i * 4 + 3] = Math.round((data[i * 4 + 3]! * mask[i]!) / 255);
      }
      ctx.putImageData(imageData, 0, 0);
      const display = displayRef.current;
      if (display) {
        const dctx = display.getContext("2d")!;
        dctx.clearRect(0, 0, display.width, display.height);
        dctx.drawImage(base, 0, 0);
      }
      setPoints([]);
      maskRef.current = null;
      paintOverlay(null, []);
      pushHistory({ points: [], canvasData: snapshotCanvas() });
      setStatus("Background removed. Click a part to cut it out, or change image.");
      persistImage();
    } catch (err) {
      setStatus(`Couldn't remove background: ${(err as Error).message}`);
    } finally {
      setRemovingBg(false);
    }
  }, [paintOverlay, ready, pushHistory, snapshotCanvas, persistImage]);

  const download = (part: Part) => {
    const a = document.createElement("a");
    a.href = part.dataUrl;
    a.download = `${part.name}.png`;
    a.click();
  };

  return (
    <div className="relative mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-14">
      {/* Full-screen loading overlay — blurs the entire screen while models load. */}
      {!modelsLoaded && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background/80 backdrop-blur-xl">
          <div className="flex flex-col items-center gap-5">
            <Spinner className="size-10 animate-spin text-accent" />
            <div className="text-center">
              <h2 className="font-display text-xl text-foreground">Loading up models…</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Retrieving models needed for image editing and background removal.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main content — fades in and slides up when models are ready. */}
      <div
        className={`transition-all duration-700 ${
          modelsLoaded
            ? "animate-in fade-in slide-in-from-bottom-8 duration-700"
            : "pointer-events-none blur-sm"
        }`}
      >
      <header className="mb-8 flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium tracking-wide text-accent">
          Pluck • v0.1.0
        </span>
        <h1 className="font-display text-3xl leading-tight text-foreground sm:text-5xl">
          Click anything. Cut it out.
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
          Drop in a photo and tap hair, a face, a hand or an accessory. Each selection becomes a
          transparent PNG you can export.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-3 shadow-elegant sm:p-4">
          {!hasImage ? (
            <label className="flex aspect-4/3 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/40 text-center transition-colors hover:border-accent/60 hover:bg-muted/70">
              <UploadSimple weight="fill" className="size-6 text-accent" />
              <span className="text-sm font-medium text-foreground">Upload an image</span>
              <span className="text-xs text-muted-foreground">PNG or JPG, up to any size</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </label>
          ) : (
            <div className="relative mx-auto max-w-2xl overflow-hidden rounded-xl bg-checker">
              {/* Canvas is always mounted — blurred until the image is ready. */}
              <div
                className={`transition-all duration-500 ${
                  imageReady
                    ? "animate-in fade-in slide-in-from-bottom-4 duration-500 blur-0"
                    : "blur-md"
                }`}
              >
                <canvas ref={displayRef} className="block w-full" />
                <canvas
                  ref={overlayRef}
                  onClick={handleClick}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={() => {
                    if (isDrawingRef.current) handlePointerUp();
                  }}
                  className="absolute inset-0 block w-full cursor-crosshair touch-none"
                />
              </div>
              {/* Uploading overlay — spinner + text while encoding runs. */}
              {!imageReady && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 text-center">
                  <Spinner className="size-7 animate-spin text-accent" />
                  <span className="text-sm font-medium text-foreground">Uploading image…</span>
                </div>
              )}
              {imageReady && busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/45 backdrop-blur-[2px]">
                  <Spinner className="size-6 animate-spin text-accent" />
                </div>
              )}
              {imageReady && removingBg && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/55 backdrop-blur-md">
                  <Spinner className="size-7 animate-spin text-white" />
                  <span className="text-sm font-medium text-white">Removing background…</span>
                </div>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <div
            className={`mx-auto mt-3 w-full max-w-2xl overflow-x-auto rounded-full border-2 border-border bg-card px-1 py-1 transition-opacity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
              removingBg || !imageReady ? "pointer-events-none opacity-40" : ""
            }`}
          >
            <div className="flex w-max items-center gap-2">
              <div className="flex items-center gap-2">
              <Button variant="hero" size="sm" onClick={addPart} className="rounded-full shadow-xl">
                <Plus className="size-4" /> Add as part
              </Button>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={undo}
                  disabled={!canUndo || busy || removingBg || !imageReady}
                  className={`h-8 w-8 rounded-full shadow-xl ${canUndo ? "" : "opacity-30"}`}
                  title="Undo"
                >
                  <ArrowUUpLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={redo}
                  disabled={!canRedo || busy || removingBg || !imageReady}
                  className={`h-8 w-8 rounded-full shadow-xl ${canRedo ? "" : "opacity-30"}`}
                  title="Redo"
                >
                  <ArrowUUpRight className="size-4" />
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={removeBackground}
                disabled={!hasImage || !ready || busy || removingBg || !imageReady}
                className="rounded-full shadow-xl"
              >
                <Eraser className="size-4" /> Remove background
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={resetEdits}
                disabled={!hasImage || busy || removingBg || !imageReady}
                className="rounded-full shadow-xl"
                title="Restore the original image and clear all edits"
              >
                <ArrowClockwise className="size-4" /> Reset
              </Button>
              <Tabs
                value={mode}
                onValueChange={(v) => setMode(v as "mask" | "exclude" | "cut")}
                className="flex items-center"
              >
                <TabsList className="h-8 rounded-full">
                  <TabsTrigger
                    value="mask"
                    className="rounded-full text-xs data-[state=active]:bg-[var(--theme-primary)] data-[state=active]:text-black"
                  >
                    Mask
                  </TabsTrigger>
                  <TabsTrigger
                    value="exclude"
                    className="rounded-full text-xs data-[state=active]:bg-[#ff5f7e] data-[state=active]:text-white"
                  >
                    Exclude
                  </TabsTrigger>
                  <TabsTrigger
                    value="cut"
                    className="rounded-full text-xs data-[state=active]:bg-[#5f9eff] data-[state=active]:text-white"
                  >
                    Cut
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs
                value={paintMode}
                onValueChange={(v) => setPaintMode(v as "auto" | "manual")}
                className="flex items-center"
              >
                <TabsList className="h-8 rounded-full">
                  <TabsTrigger
                    value="auto"
                    className="rounded-full text-xs data-[state=active]:bg-[#22d3ee] data-[state=active]:text-black"
                  >
                    Auto
                  </TabsTrigger>
                  <TabsTrigger
                    value="manual"
                    className="rounded-full text-xs data-[state=active]:bg-[#fb923c] data-[state=active]:text-black"
                  >
                    Manual
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {hasImage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full shadow-xl"
                >
                  <UploadSimple className="size-4" /> Change image
                </Button>
              )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTool((t) => (t === "chroma" ? "none" : "chroma"))}
                disabled={!hasImage || !ready || busy || removingBg || !imageReady}
                className={`rounded-full shadow-xl ${tool === "chroma" ? "bg-accent! text-black!" : ""}`}
                title="Chroma key — click a color to cut it out"
              >
                <Eyedropper className="size-4" /> Chroma key
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTool((t) => (t === "picker" ? "none" : "picker"))}
                disabled={!hasImage || !ready || busy || removingBg || !imageReady}
                className={`rounded-full shadow-xl ${tool === "picker" ? "bg-accent! text-black!" : ""}`}
              >
                <Palette className="size-4" /> Color picker
              </Button>
              {pickedColor && (
                <div className="flex h-8 items-center gap-2 rounded-full border-2 border-border bg-card px-3 shadow-xl">
                  <span
                    className="size-4 rounded-full border border-border"
                    style={{ backgroundColor: pickedColor }}
                  />
                  <span className="font-mono text-xs text-foreground">{pickedColor}</span>
                </div>
              )}
            </div>
          </div>
          <div className="mx-auto mt-2 flex w-full max-w-2xl items-center gap-3 rounded-full border-2 border-border bg-card px-4 py-1.5 shadow-xl">
            <span className="text-xs font-medium text-muted-foreground">Brush Size</span>
            <Slider
              value={[brushSize]}
              onValueChange={(v) => setBrushSize(v[0] ?? 1)}
              min={1}
              max={50}
              step={1}
              className="flex-1"
            />
            <span className="w-10 text-right font-mono text-xs text-foreground">
              {brushSize}px
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {status} <span className="text-accent">Click</span> to select,{" "}
            <span className="text-accent">drag</span> to draw, or use{" "}
            <span className="text-accent">Exclude</span>/<span className="text-accent">Cut</span> to
            refine or extract.
          </p>
        </section>

        <section className="min-w-0 rounded-2xl border border-border bg-card p-4">
          <h2 className="font-display text-lg text-foreground">Cut-out parts</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {parts.length ? `${parts.length} saved` : "Nothing yet — click a part in the image."}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {parts.map((part) => (
              <div
                key={part.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3"
              >
                <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-checker">
                  <img
                    src={part.dataUrl}
                    alt={part.name}
                    className="size-full object-contain"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <input
                    value={part.name}
                    onChange={(e) =>
                      setParts((prev) =>
                        prev.map((p) => (p.id === part.id ? { ...p, name: e.target.value } : p)),
                      )
                    }
                    className="w-full rounded-md border border-transparent bg-transparent text-sm font-medium text-foreground outline-none focus:border-border focus:px-1"
                  />
                  <span className="text-xs text-muted-foreground">
                    {part.width} × {part.height} px
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="outline" onClick={() => download(part)}>
                    <Download className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => {
                      setParts((prev) => prev.filter((p) => p.id !== part.id));
                    }}
                  >
                    <Trash className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {parts.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4 w-full"
              onClick={() => parts.forEach((p, i) => setTimeout(() => download(p), i * 250))}
            >
              <Download className="size-4" /> Export all as PNG
            </Button>
          )}
        </section>
      </div>
      </div>
    </div>
  );
}
