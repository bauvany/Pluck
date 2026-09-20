import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime-web ships native bindings that must not be bundled for the
  // server build. It is only imported from a client-only dynamic import.
  serverExternalPackages: ["onnxruntime-web"],
  allowedDevOrigins: ["127.0.0.1"],
  // public/ assets are served with max-age=0 by default; the ONNX models are
  // large and versioned by filename, so cache them aggressively.
  async headers() {
    return [
      {
        source: "/models/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
