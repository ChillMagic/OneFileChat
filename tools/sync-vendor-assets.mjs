import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outVendorDir = path.join(rootDir, 'out', 'vendor');

const assets = [
  {
    source: path.join(rootDir, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
    target: path.join(outVendorDir, 'codicons', 'codicon.css')
  },
  {
    source: path.join(rootDir, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf'),
    target: path.join(outVendorDir, 'codicons', 'codicon.ttf')
  },
  {
    source: path.join(rootDir, 'node_modules', 'katex', 'dist', 'katex.min.css'),
    target: path.join(outVendorDir, 'katex', 'katex.min.css')
  },
  {
    source: path.join(rootDir, 'node_modules', 'katex', 'dist', 'fonts'),
    target: path.join(outVendorDir, 'katex', 'fonts'),
    recursive: true
  }
];

await rm(outVendorDir, { recursive: true, force: true });

for (const asset of assets) {
  await mkdir(path.dirname(asset.target), { recursive: true });
  await cp(asset.source, asset.target, { recursive: asset.recursive ?? false });
}

console.log('[vendor] synced ->', outVendorDir);