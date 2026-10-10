import type { NextConfig } from "next";
import path from "node:path";
import { assertReasoningConfiguration } from "./lib/reasoning-store";
import { demoAccessState } from "./lib/demo-access-store";

if (process.env.WORKBENCH_REASONING_DB) assertReasoningConfiguration();
demoAccessState(); // On configuration load, disabling demo invalidates its old epoch before listening.

const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  turbopack: { root: path.resolve(__dirname) },
  // All product API routes are explicit server handlers; never proxy legacy CMS APIs.
  async rewrites() { return []; },
};

export default nextConfig;
