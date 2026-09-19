"use client";

import dynamic from "next/dynamic";

const CutoutEditor = dynamic(() => import("./CutoutEditor").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Loading studio…
    </div>
  ),
});

export function CutoutEditorClient() {
  return <CutoutEditor />;
}
