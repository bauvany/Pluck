import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const CutoutEditor = lazy(() => import("@/components/CutoutEditor"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cutout Studio — click-to-cut image editor" },
      {
        name: "description",
        content:
          "Upload a photo, click any part — hair, face, hands, accessories — and export it as a transparent PNG. Powered by MobileSAM in your browser.",
      },
      { property: "og:title", content: "Cutout Studio — click-to-cut image editor" },
      {
        property: "og:description",
        content:
          "Click any part of a photo and export it as a transparent PNG, all in your browser with MobileSAM.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Fallback() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Loading studio…
    </div>
  );
}

function Index() {
  return (
    <main className="min-h-screen bg-background">
      <ClientOnly fallback={<Fallback />}>
        <Suspense fallback={<Fallback />}>
          <CutoutEditor />
        </Suspense>
      </ClientOnly>
    </main>
  );
}
