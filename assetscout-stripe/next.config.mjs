import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));

/**
 * AssetScout — Next.js configuration.
 *
 * Local build notes (Android / VSCodroid only, not a production concern):
 *  - Next.js publishes no native SWC binary for android/arm64, so the build falls
 *    back to `@next/swc-wasm-nodejs` (staged by `scripts/setup-swc-wasm.mjs`,
 *    wired to `postinstall` + `prebuild`). No Babel fallback, no version drift.
 *
 * Production notes:
 *  - `outputFileTracingRoot` pins dependency tracing to THIS app. Without it
 *    Next.js walks up, finds unrelated lockfiles in parent directories and traces
 *    the wrong tree.
 *  - `typescript.ignoreBuildErrors` is deliberately not enabled: type errors must
 *    fail the build.
 *  - `serverExternalPackages` keeps the Stripe SDK out of the bundler so its
 *    Node-only internals (crypto, http) behave exactly as shipped.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: appRoot,
  serverExternalPackages: ['stripe'],
  typescript: {
    ignoreBuildErrors: false,
  },
  // No ESLint dependency/config ships with this app; `npm run typecheck` is the
  // static gate (see README §Quality gates). Do not re-enable until a config exists.
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // Applied to every route, including API responses (defence in depth; no
        // route relies on these for authorisation).
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;