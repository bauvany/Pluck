import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUUpLeft,
  ArrowUUpRight,
  Download,
  Eraser,
  MagicWand,
  Plus,
  Spinner,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
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

type Part = Cutout & { id: string; name: string };

type Snapshot = {
  points: Point[];
  canvasData: ImageData | null;
};

export default function CutoutEditor() {
  const baseCanvas = useRef<HTMLCanvasElement | null>(null);
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
  const [mode, setMode] = useState<"mask" | "exclude" | "cut">("mask");
  const drawPathRef = useRef<{ x: number; y: number }[]>([]);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isDrawingRef = useRef(false);
  const dragOccurredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadModel(), loadCrispcut()])
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
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const j = i * 4;
        img.data[j] = 90;
        img.data[j + 1] = 240;
        img.data[j + 2] = 200;
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
    async (pts: Point[]) => {
      const encoded = encodedRef.current;
      if (!encoded || pts.length === 0) {
        maskRef.current = null;
        paintOverlay(null, pts);
        return;
      }
      setBusy(true);
      setStatus("Finding that part…");
      try {
        const mask = await segment(encoded, pts);
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
      } catch (err) {
        setStatus(`Cut failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [paintOverlay, pushHistory, snapshotCanvas],
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

  // Draw/lasso mode — freehand path that samples interior points for SAM.
  const isPointInPolygon = useCallback(
    (x: number, y: number, poly: { x: number; y: number }[]) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x;
        const yi = poly[i]!.y;
        const xj = poly[j]!.x;
        const yj = poly[j]!.y;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    },
    [],
  );

  const drawLassoPath = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    paintOverlay(maskRef.current, points);
    const path = drawPathRef.current;
    if (path.length < 2) return;
    const ctx = overlay.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(path[0]!.x, path[0]!.y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
    ctx.strokeStyle = "#3ce6b4";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [paintOverlay, points]);

  const sampleInteriorPoints = useCallback(
    (path: { x: number; y: number }[], count: number): Point[] => {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of path) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pts: Point[] = [];
      const label: 0 | 1 = mode === "exclude" ? 0 : 1;
      // Always include the centroid if inside.
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      if (isPointInPolygon(cx, cy, path)) pts.push({ x: cx, y: cy, label });
      // Grid-sample interior points.
      const w = maxX - minX;
      const h = maxY - minY;
      const step = Math.max(2, Math.floor(Math.min(w, h) / 4));
      for (let y = minY + step / 2; y < maxY && pts.length < count; y += step) {
        for (let x = minX + step / 2; x < maxX && pts.length < count; x += step) {
          if (isPointInPolygon(x, y, path)) pts.push({ x, y, label });
        }
      }
      return pts;
    },
    [isPointInPolygon, mode],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!hasImage || !ready || !imageReady || busy || removingBg) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * e.currentTarget.width;
      const y = ((e.clientY - rect.top) / rect.height) * e.currentTarget.height;
      drawStartRef.current = { x, y };
      drawPathRef.current = [{ x, y }];
      isDrawingRef.current = false;
      dragOccurredRef.current = false;
    },
    [hasImage, ready, imageReady, busy, removingBg],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const start = drawStartRef.current;
      if (!start) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * e.currentTarget.width;
      const y = ((e.clientY - rect.top) / rect.height) * e.currentTarget.height;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!isDrawingRef.current && dx * dx + dy * dy > 25) {
        // Moved more than ~5px — this is a drag, start drawing.
        isDrawingRef.current = true;
        dragOccurredRef.current = true;
      }
      if (isDrawingRef.current) {
        drawPathRef.current.push({ x, y });
        drawLassoPath();
      }
    },
    [drawLassoPath],
  );

  const handlePointerUp = useCallback(() => {
    if (!isDrawingRef.current) {
      drawStartRef.current = null;
      return;
    }
    isDrawingRef.current = false;
    drawStartRef.current = null;
    const path = drawPathRef.current;
    drawPathRef.current = [];
    if (path.length < 3) return;
    const sampled = sampleInteriorPoints(path, 8);
    if (sampled.length === 0) {
      setStatus("Drawn area was too small — try a larger selection.");
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
  }, [points, mode, sampleInteriorPoints, pushHistory, snapshotCanvas, runSegment, runCut]);

  const handleFile = useCallback(
    async (file: File) => {
      setImageReady(false);
      setBusy(true);
      setStatus("Reading your image…");
      try {
        const canvas = await fileToCanvas(file);
        baseCanvas.current = canvas;
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
    [paintOverlay, snapshotCanvas, updateHistoryFlags],
  );

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
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
    if (mode === "cut") {
      const label: 0 | 1 = 1;
      const next = [...points, { x, y, label }];
      setPoints(next);
      void runCut(next);
      return;
    }
    const label: 0 | 1 = mode === "exclude" ? 0 : 1;
    const next = [...points, { x, y, label }];
    setPoints(next);
    pushHistory({ points: next, canvasData: snapshotCanvas() });
    void runSegment(next);
  };

  const addPart = () => {
    const base = baseCanvas.current;
    const mask = maskRef.current;
    if (!base || !mask) return;
    const cutout = maskToCutout(base, mask);
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

  const clearPoints = () => {
    setPoints([]);
    maskRef.current = null;
    paintOverlay(null, []);
    pushHistory({ points: [], canvasData: snapshotCanvas() });
    setStatus("Selection cleared.");
  };

  const removeBackground = useCallback(async () => {
    const base = baseCanvas.current;
    if (!base || !ready) return;
    setRemovingBg(true);
    setStatus("Removing background…");
    try {
      const mask = await crispcutRemoveBg(base);
      const ctx = base.getContext("2d")!;
      const imageData = ctx.getImageData(0, 0, base.width, base.height);
      const data = imageData.data;
      // CrispCut returns a soft alpha mask (0-255) for better edge quality.
      for (let i = 0; i < mask.length; i++) {
        data[i * 4 + 3] = mask[i]!; // apply soft alpha
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
    } catch (err) {
      setStatus(`Couldn't remove background: ${(err as Error).message}`);
    } finally {
      setRemovingBg(false);
    }
  }, [paintOverlay, ready, pushHistory, snapshotCanvas]);

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
          Artura
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
              <Button variant="hero" size="sm" onClick={addPart} disabled={!maskRef.current || busy || removingBg || !imageReady} className="rounded-full shadow-xl">
                <Plus className="size-4" /> Add as part
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={removeBackground}
                disabled={!hasImage || !ready || busy || removingBg || !imageReady}
                className="rounded-full border-0 shadow-xl"
              >
                <Eraser className="size-4" /> Remove background
              </Button>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={undo}
                  disabled={!canUndo || busy || removingBg || !imageReady}
                  className={`h-8 w-8 rounded-full border-0 shadow-xl ${canUndo ? "" : "opacity-30"}`}
                  title="Undo"
                >
                  <ArrowUUpLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={redo}
                  disabled={!canRedo || busy || removingBg || !imageReady}
                  className={`h-8 w-8 rounded-full border-0 shadow-xl ${canRedo ? "" : "opacity-30"}`}
                  title="Redo"
                >
                  <ArrowUUpRight className="size-4" />
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={clearPoints}
                disabled={!points.length || removingBg || !imageReady}
                className="rounded-full border-0 shadow-xl"
              >
                <ArrowClockwise className="size-4" /> Clear points
              </Button>
              <Tabs
                value={mode}
                onValueChange={(v) => setMode(v as "mask" | "exclude" | "cut")}
                className="flex items-center"
              >
                <TabsList className="h-8 rounded-full">
                  <TabsTrigger
                    value="mask"
                    className="rounded-full text-xs data-[state=active]:bg-[#3ce6b4] data-[state=active]:text-black"
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
              {hasImage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full border-0 shadow-xl"
                >
                  <UploadSimple className="size-4" /> Change image
                </Button>
              )}
            </div>
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
