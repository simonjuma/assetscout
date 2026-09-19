/**
 * VERIFICATION RIG ONLY - do not merge.
 *
 * Your real repo already has a next.config.*; this file exists only so the
 * drop-in billing files can be type-checked and built here.
 *
 * NOTE (this device): Next.js has no native SWC binary for android/arm64, so the
 * build falls back to @next/swc-wasm-nodejs. Nothing in the billing code depends
 * on this - it is purely a local build-rig concern.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // The billing code uses `import 'server-only'` guards; keep strict mode on and
  // DO NOT add typescript.ignoreBuildErrors - type errors must fail the build.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true, // no ESLint config in this rig; the real repo lints
  },
};

export default nextConfig;