import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Plus, RotateCcw, Trash2, Upload, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

type Part = Cutout & { id: string; name: string };

export default function CutoutEditor() {
  const baseCanvas = useRef<HTMLCanvasElement | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const encodedRef = useRef<EncodedImage | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);

  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Loading MobileSAM…");
  const [busy, setBusy] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [parts, setParts] = useState<Part[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadModel((f) => !cancelled && setProgress(f))
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setStatus("Upload an image, then click a part to cut it out.");
      })
      .catch((err: Error) => setStatus(`Couldn't load the model: ${err.message}`));
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

    const r = Math.max(5, Math.round(overlay.width / 130));
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = pt.label === 1 ? "#3ce6b4" : "#ff5f7e";
      ctx.fill();
      ctx.lineWidth = Math.max(2, r / 3);
      ctx.strokeStyle = "rgba(10,14,16,0.85)";
      ctx.stroke();
    }
  }, []);

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

  const handleFile = useCallback(
    async (file: File) => {
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
      } catch (err) {
        setStatus(`Couldn't open that image: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [paintOverlay],
  );

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasImage || !ready || busy) return;
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * el.width;
    const y = ((event.clientY - rect.top) / rect.height) * el.height;
    const label: 0 | 1 = event.shiftKey || event.altKey ? 0 : 1;
    const next = [...points, { x, y, label }];
    setPoints(next);
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
    setParts((prev) => [
      { ...cutout, id: crypto.randomUUID(), name: `part-${prev.length + 1}` },
      ...prev,
    ]);
    setPoints([]);
    maskRef.current = null;
    paintOverlay(null, []);
    setStatus("Saved. Click another part to keep going.");
  };

  const clearPoints = () => {
    setPoints([]);
    maskRef.current = null;
    paintOverlay(null, []);
    setStatus("Selection cleared.");
  };

  const download = (part: Part) => {
    const a = document.createElement("a");
    a.href = part.dataUrl;
    a.download = `${part.name}.png`;
    a.click();
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-14">
      <header className="mb-8 flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium tracking-wide text-accent">
          <Wand2 className="size-3.5" /> MobileSAM · runs in your browser
        </span>
        <h1 className="font-display text-3xl leading-tight text-foreground sm:text-5xl">
          Click anything. Cut it out.
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
          Drop in a photo and tap hair, a face, a hand or an accessory. Each selection becomes a
          transparent PNG you can export.
        </p>
      </header>

      {!ready && (
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{status}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${Math.max(4, progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-2xl border border-border bg-card p-3 shadow-elegant sm:p-4">
          {!hasImage ? (
            <label className="flex aspect-4/3 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/40 text-center transition-colors hover:border-accent/60 hover:bg-muted/70">
              <Upload className="size-6 text-accent" />
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
            <div className="relative overflow-hidden rounded-xl bg-checker">
              <canvas ref={displayRef} className="block w-full" />
              <canvas
                ref={overlayRef}
                onClick={handleClick}
                className="absolute inset-0 block w-full cursor-crosshair"
              />
              {busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/45 backdrop-blur-[2px]">
                  <Loader2 className="size-6 animate-spin text-accent" />
                </div>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="hero" size="sm" onClick={addPart} disabled={!maskRef.current || busy}>
              <Plus className="size-4" /> Add as part
            </Button>
            <Button variant="outline" size="sm" onClick={clearPoints} disabled={!points.length}>
              <RotateCcw className="size-4" /> Clear points
            </Button>
            {hasImage && (
              <label className="ml-auto cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Change image
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
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {status} <span className="text-accent">Shift-click</span> to remove an area from the
            selection.
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
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
                  <Button size="icon" variant="ghost" onClick={() => download(part)}>
                    <Download className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setParts((prev) => prev.filter((p) => p.id !== part.id))}
                  >
                    <Trash2 className="size-4" />
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
  );
}
