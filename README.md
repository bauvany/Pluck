# Pluck

Pluck is a free, no-ads image cut-out editor. Upload any image, click on any part (hair, face, body parts, accessories, etc.) and have that part cut out. Export feature included to export those parts as transparent PNGs.

## Stack

- [Next.js](https://nextjs.org/) (App Router) + React 19
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- [onnxruntime-web](https://onnxruntime.ai/) running models in the browser
- [Bun](https://bun.sh/) as the package manager

## Models

- [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) — powers click-to-cut segmentation (encoder + decoder, ~45 MB, served from `public/models/`). Licensed under [Apache-2.0](public/models/LICENSE).
- [BiRefNet_lite-512](https://huggingface.co/studioludens/birefnet-lite-512) — powers background removal (fp16 ~94 MB on WebGPU, fp32 ~183 MB on WASM fallback, loaded from HuggingFace on first use). MIT-licensed.

## Development

```sh
bun install
bun run dev
```

Then open http://localhost:5000.

## Build

```sh
bun run build
bun run start
```
