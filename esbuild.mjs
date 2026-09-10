import { build, context } from 'esbuild';

const configurations = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { entryPoints: ['src/webview/settings.ts'], outfile: 'dist/settings.js', platform: 'browser', format: 'iife', target: 'es2022' },
];
for (const configuration of configurations) {
  const options = { ...configuration, bundle: true, sourcemap: true, logLevel: 'info' };
  if (process.argv.includes('--watch')) await (await context(options)).watch();
  else await build(options);
}
