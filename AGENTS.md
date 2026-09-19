# Cutout Studio

Next.js (App Router) + React 19 + Tailwind CSS v4 + shadcn/ui project.

## Stack

- **Framework**: Next.js (App Router) with React Server Components
- **Package manager**: Bun
- **Styling**: Tailwind CSS v4 (via `@tailwindcss/postcss`)
- **UI**: shadcn/ui (new-york style) + Radix UI primitives
- **Models**: MobileSAM ONNX models hosted on Supabase Storage (public bucket)

## Commands

- `bun run dev` — start the Next.js dev server
- `bun run build` — production build
- `bun run start` — serve the production build
- `bun run lint` — run ESLint
- `bun run format` — run Prettier

## Structure

- `app/` — Next.js App Router (layout, page, error/not-found boundaries, globals.css)
- `src/components/` — React components (CutoutEditor + shadcn/ui primitives)
- `src/lib/` — utilities (mobilesam model inference, cn helper)
- `src/hooks/` — React hooks
- `public/` — static assets (favicon, robots.txt)

## Notes

- The CutoutEditor is loaded client-side only (`next/dynamic` with `ssr: false`) because
  onnxruntime-web requires browser APIs.
- The `@/*` path alias maps to `./src/*`.
- ONNX model URLs are defined in `src/lib/mobilesam.ts` and point to Supabase Storage.
