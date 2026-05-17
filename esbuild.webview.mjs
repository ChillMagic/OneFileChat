import esbuild from 'esbuild';
import babel from 'esbuild-plugin-babel';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const options = {
  entryPoints: [path.join(__dirname, 'src/webview/main.tsx')],
  bundle: true,
  outfile: path.join(__dirname, 'media/dist/webview.js'),
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  sourcemap: false,
  minify,
  logLevel: 'info',
  plugins: [
    babel({
      filter: /\.(t|j)sx$/,
      config: {
        presets: [
          ['babel-preset-solid'],
          ['@babel/preset-typescript', { allExtensions: true, isTSX: true }]
        ]
      }
    })
  ]
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[webview] watching...');
} else {
  await esbuild.build(options);
  console.log('[webview] built ->', options.outfile);
}
