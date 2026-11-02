import type { NextConfig } from "next";

// A downloaded/forked copy is a standalone app, even under another npm directory.
const root = process.cwd();
const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
