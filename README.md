# Pluck

Pluck is ann image cut-out editor using MobileSAM. Upload any image, click on any part (hair, face, body parts, accessories, etc.) and have that part cut out. Export feature included to export those parts as transparent PNGs.

## Stack

- [Next.js](https://nextjs.org/) (App Router) + React 19
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- [onnxruntime-web](https://onnxruntime.ai/) running MobileSAM in the browser
- [Bun](https://bun.sh/) as the package manager
- ONNX models served from `public/models/`

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
