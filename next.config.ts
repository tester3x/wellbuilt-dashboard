import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  // Static export — all pages are client-side rendered.
  // No Cloud Run SSR function needed. Firebase Hosting serves static files only.
  webpack: (config) => {
    // Build-compat shim (toolchain only, no runtime effect): the bundled webpack in
    // Next 16 crashes in its WASM xxhash (WasmHash._updateWithBuffer → "Cannot read
    // properties of undefined (reading 'length')") under Node 24. Use Node's crypto
    // sha256 for content hashing instead — same static output, no WASM path.
    config.output.hashFunction = 'sha256';
    return config;
  },
};

export default nextConfig;
