# Pluck

Next.js (App Router) + React 19 + Tailwind CSS v4 + shadcn/ui project.

## Stack

- **Framework**: Next.js (App Router) with React Server Components
- **Package manager**: Bun
- **Styling**: Tailwind CSS v4 (via `@tailwindcss/postcss`)
- **UI**: shadcn/ui (new-york style) + Radix UI primitives
- **Models**: MobileSAM ONNX models served from `public/models/` (Apache-2.0,
  license in `public/models/LICENSE`); background removal via BiRefNet_lite-512
  (MIT license, fp16 ~94MB on WebGPU / fp32 ~183MB on WASM fallback) loaded
  from HuggingFace CDN.

## Commands

- `bun run dev` — start the Next.js dev server
- `bun run build` — production build
- `bun run start` — serve the production build
- `bun run lint` — run ESLint
- `bun run typecheck` — run `tsc --noEmit`
- `bun run check` — run lint + typecheck
- `bun run format` — run Prettier

## Structure

- `app/` — Next.js App Router (layout, page, error/not-found boundaries, globals.css)
- `components/` — React components (CutoutEditor + shadcn/ui primitives)
- `lib/` — utilities (mobilesam inference, crispcut bg-removal, model-cache, idb, cn helper)
- `hooks/` — React hooks
- `public/` — static assets (favicon, robots.txt, `models/` ONNX files)

## Notes

- The CutoutEditor is loaded client-side only (`next/dynamic` with `ssr: false`) because
  onnxruntime-web requires browser APIs.
- The `@/*` path alias maps to the repo root (`./*`).
- Model URLs are in `lib/mobilesam.ts` (`/models/*.onnx`, same-origin) and
  `lib/crispcut.ts` (HuggingFace CDN).
- `next.config.ts` sets immutable Cache-Control headers on `/models/*`.
- Project license: PolyForm Noncommercial 1.0.0 (see `LICENSE`).
