import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  // Static export — all pages are client-side rendered.
  // No Cloud Run SSR function needed. Firebase Hosting serves static files only.
};

export default nextConfig;
