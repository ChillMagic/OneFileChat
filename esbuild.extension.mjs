import esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const outDir = path.join(__dirname, 'out');
const extensionOutfile = path.join(outDir, 'extension.js');

await fs.mkdir(outDir, { recursive: true });
await fs.rm(extensionOutfile, { force: true });

const options = {
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: extensionOutfile,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify,
  logLevel: 'info'
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[extension] watching...');
} else {
  await esbuild.build(options);
  console.log('[extension] built ->', options.outfile);
}