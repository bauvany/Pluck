import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime-web ships native bindings that must not be bundled for the
  // server build. It is only imported from a client-only dynamic import.
  serverExternalPackages: ["onnxruntime-web"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
