/** CLI: regenerate tokens.css from tokens.ts (pnpm --filter @terminal/ui gen:css). */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderCss } from './tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'tokens.css');
writeFileSync(target, renderCss());
process.stdout.write(`wrote ${target}\n`);
