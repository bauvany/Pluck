# Pluck

Pluck is a free, no-ads image cut-out editor. Upload any image, click on any part (hair, face, body parts, accessories, etc.) and have that part cut out. Export feature included to export those parts as transparent PNGs.

## Stack

- [Next.js](https://nextjs.org/) (App Router) + React 19
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- [onnxruntime-web](https://onnxruntime.ai/) running models in the browser
- [Bun](https://bun.sh/) as the package manager

## Models

- [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) — powers click-to-cut segmentation (encoder + decoder, ~45 MB, served from `public/models/`). Licensed under [Apache-2.0](public/models/LICENSE).
- [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) by BRIA AI — powers background removal (~176 MB, loaded from HuggingFace on first use). Licensed for [non-commercial use](https://huggingface.co/briaai/RMBG-1.4/blob/main/LICENSE) only.

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
