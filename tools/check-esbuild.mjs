// Pre-build check: ensures esbuild is installed for the current platform.
// When node_modules is copied between OSes (e.g. Linux ↔ Windows),
// esbuild's native binary won't match. This script detects the mismatch
// and auto-reinstalls dependencies for the current platform.
//
// Usage: node tools/check-esbuild.mjs

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function getExpectedPlatformPkg() {
  const platform = process.platform;   // 'win32', 'linux', 'darwin'
  const arch = process.arch;           // 'x64', 'arm64'

  const platformMap = {
    win32: 'win32',
    linux: 'linux',
    darwin: 'darwin',
  };

  const platformPart = platformMap[platform];
  if (!platformPart) {
    console.error(`[check-esbuild] Unsupported platform: ${platform}`);
    process.exit(1);
  }

  return `@esbuild/${platformPart}-${arch}`;
}

/**
 * Check node_modules/@esbuild/ for platform-specific packages.
 * Returns true if the correct platform package is installed,
 * or if no @esbuild packages exist at all (clean slate).
 */
function checkPlatform() {
  const expected = getExpectedPlatformPkg();
  const expectedPath = resolve(projectRoot, 'node_modules', expected);

  if (existsSync(expectedPath)) {
    return { ok: true };
  }

  const esbuildDir = resolve(projectRoot, 'node_modules', '@esbuild');
  if (!existsSync(esbuildDir)) {
    // No esbuild platform packages at all — first install, fine
    return { ok: true };
  }

  // Some @esbuild/* packages exist but not the expected one — mismatch
  const installed = readdirSync(esbuildDir).filter(d => d.startsWith('@esbuild/') || true).map(d => `@esbuild/${d}`);
  return {
    ok: false,
    expected,
    installed: readdirSync(esbuildDir).map(d => `@esbuild/${d}`).join(', '),
  };
}

function reinstall() {
  console.log(`[check-esbuild] Reinstalling dependencies for ${process.platform}-${process.arch}...`);
  try {
    execSync('npm install', {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    console.log('[check-esbuild] Done.');
  } catch (_err) {
    console.error('[check-esbuild] Failed. Please run "npm install" manually.');
    process.exit(1);
  }
}

// --- Main ---

const result = checkPlatform();
if (!result.ok) {
  console.log(`[check-esbuild] Platform mismatch: expected ${result.expected}, found ${result.installed}`);
  reinstall();

  // Double-check after reinstall
  const retry = checkPlatform();
  if (!retry.ok) {
    console.error(`[check-esbuild] Still mismatched after reinstall.`);
    process.exit(1);
  }
}
