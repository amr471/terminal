/**
 * @terminal/api-gateway — REST + browser WebSocket gateway; auth, accounts,
 * billing (P1.1/P1.2). Auth landed in P1.1; billing/WS fan-out land in P1.2/P1.17.
 */
import { buildApp } from './app.js';
import { config } from './config.js';

export const SERVICE_NAME = '@terminal/api-gateway';

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('[api-gateway] fatal startup error:', err);
    process.exit(1);
  });
}
