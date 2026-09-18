import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await copyFile('node_modules/katex/LICENSE', 'dist/katex-LICENSE.txt');

const configurations = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { entryPoints: ['src/webview/settings.ts'], outfile: 'dist/settings.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { entryPoints: ['media/chat.css'], outfile: 'dist/chat.css', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]' },
];
for (const configuration of configurations) {
  const options = { ...configuration, bundle: true, sourcemap: true, logLevel: 'info' };
  if (process.argv.includes('--watch')) await (await context(options)).watch();
  else await build(options);
}
