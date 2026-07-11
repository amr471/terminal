import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Shared flat ESLint config for all TS workspaces. */
export default tseslint.config(
  { ignores: ['dist/', '.next/', '.turbo/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Secrets never in logs (CLAUDE.md §9) — force explicit, reviewable logging.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
