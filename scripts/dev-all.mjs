#!/usr/bin/env node
/**
 * Cross-platform `pnpm dev:all` — dispatches to the right per-OS launcher so
 * one command works on both of John's targets:
 *
 *   macOS   -> scripts/dev-all.command (AppleScript, three Terminal windows)
 *   Windows -> scripts/dev-all.ps1     (Windows Terminal tabs, or 3 pwsh windows)
 *   Linux   -> not wired; prints the three commands to run manually, since
 *              there's no single terminal emulator we can assume is installed.
 *
 * Each dev process gets its own window deliberately: market-data is extremely
 * chatty, and any one process needs to be Ctrl-C-able without killing the
 * others. Infra must already be up (`pnpm dev:up && pnpm dev:migrate`).
 */
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const COMMANDS = [
  'cd services/market-data && go run ./cmd/market-data',
  'pnpm dev:gateway',
  'pnpm dev:web',
];

function run(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`dev:all: failed to launch ${cmd}: ${err.message}`);
    process.exit(1);
  });
}

if (process.platform === 'darwin') {
  const launcher = join(scriptsDir, 'dev-all.command');
  // Keep the double-clickable bit set even after a fresh clone (git preserves
  // the exec bit, but a zip download or a Windows-side checkout may not).
  try {
    chmodSync(launcher, 0o755);
  } catch {
    // Non-fatal: bash can still run it explicitly below.
  }
  run('bash', [launcher]);
} else if (process.platform === 'win32') {
  const launcher = join(scriptsDir, 'dev-all.ps1');
  // pwsh (PowerShell 7+) first, powershell.exe as the built-in fallback.
  const shell = process.env.DEV_ALL_PWSH ?? 'pwsh';
  run(shell, ['-ExecutionPolicy', 'Bypass', '-File', launcher]);
} else {
  console.log('dev:all: no launcher for this platform. Run these in 3 terminals:\n');
  for (const c of COMMANDS) console.log(`  ${c}`);
  process.exit(0);
}
