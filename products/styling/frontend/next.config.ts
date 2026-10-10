import type { NextConfig } from "next";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8010";

const config: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [
      { source: "/tryon-results/:path*", destination: `${BACKEND}/tryon-results/:path*` },
      { source: "/product-images/:path*", destination: `${BACKEND}/product-images/:path*` },
    ];
  },
};

export default config;
