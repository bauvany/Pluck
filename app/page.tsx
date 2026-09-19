import type { Metadata } from "next";
import { CutoutEditorClient } from "@/components/CutoutEditorClient";

export const metadata: Metadata = {
  title: "Cutout Studio — click-to-cut image editor",
  description:
    "Upload a photo, click any part — hair, face, hands, accessories — and export it as a transparent PNG. Powered by MobileSAM in your browser.",
  openGraph: {
    title: "Cutout Studio — click-to-cut image editor",
    description:
      "Click any part of a photo and export it as a transparent PNG, all in your browser with MobileSAM.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background">
      <CutoutEditorClient />
    </main>
  );
}
