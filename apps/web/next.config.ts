import path from "node:path";
import type { NextConfig } from "next";
import pkg from "./package.json";

const hostWebDev = process.env.OPENNEKO_HOST_WEB_DEV === "1";
const demoMode =
  process.env.OPENNEKO_STACK_MODE === "demo" ||
  process.env.NEXT_PUBLIC_DEMO === "true" ||
  process.env.DEMO === "true";

if (hostWebDev && (process.env.NODE_ENV !== "development" || demoMode)) {
  throw new Error(
    "OPENNEKO_HOST_WEB_DEV is development-only; production and demo modes must run web inside the stack.",
  );
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  transpilePackages: [
    "@neko/db",
    "@neko/llm",
    "@neko/telemetry",
    "@neko/secret-crypt",
    "@open-neko/plugin-install",
  ],
  // Emit a self-contained build at .next/standalone for container deploys
  // (Cloud Run). Tracing root is the monorepo root so workspace deps
  // (@neko/db, @neko/llm) get included.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  experimental: {
    // Turbopack's FS cache (default-on since Next 16.1) was serving stale
    // globals.css after edits in dev. Disabling for dev only.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
