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
};

export default nextConfig;
