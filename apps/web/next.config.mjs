/**
 * api-gateway has no CORS plugin registered (browsers only ever need to talk
 * to it same-origin, per architecture.md §2 — "browser talks to api-gateway
 * only"), and P1.1's session cookie is Secure (docs/auth.md), which won't
 * round-trip over plain http://localhost. Rather than relaxing either of
 * those, this rewrite makes the gateway same-origin from the browser's point
 * of view: the browser only ever talks to https://localhost:3000 (this app,
 * run via `next dev --experimental-https`), and Next.js proxies /api/* to
 * the gateway server-side over plain HTTP internally.
 */
const GATEWAY_ORIGIN = process.env.GATEWAY_ORIGIN ?? 'http://localhost:8080';

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${GATEWAY_ORIGIN}/:path*` }];
  },
  // P1.7 UI: apps/web's own src/lib files use NodeNext-style relative
  // imports with an explicit `.js` extension (inherited from
  // @terminal/tsconfig/base.json, and required for the `.js`-extension
  // pattern node's own ESM loader needs when tsconfig.test.json compiles
  // them to real .js files for `node --test`). tsc's "bundler"
  // moduleResolution already knows to resolve that `.js` specifier back to
  // the sibling `.ts` source, but webpack — the bundler `next dev`/`next
  // build` actually run — doesn't do that rewrite by default, so any
  // src/lib file that imports another sibling src/lib file (first hit at
  // P1.7 by useScreenerSubscription.ts -> gatewaySocket.ts/
  // screenerReducer.ts, once ScreenerPanel.tsx pulled it into the app's
  // real webpack graph) 404s in the browser build with "Module not found".
  // This alias makes webpack fall back to `.ts`/`.tsx` the same way tsc
  // already does, instead of forcing every src/lib file onto one dual
  // import-extension convention.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
