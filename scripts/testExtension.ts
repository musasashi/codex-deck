import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

async function main(): Promise<void> {
  const folder = await mkdtemp(path.join(tmpdir(), 'codex-deck-extension-'));
  const workspace = path.join(folder, 'workspace'); await mkdir(workspace);
  const userData = path.join(folder, 'user-data'); await mkdir(path.join(userData, 'User'), { recursive: true });
  await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'codexDeck.cliPath': path.resolve('tests/fixtures/mock-codex.cjs'), 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none' }));
  const extensionTestsPath = path.join(folder, 'extension-tests.cjs');
  await build({ entryPoints: ['tests/extension/suite.ts'], outfile: extensionTestsPath, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
  await runTests({
    extensionDevelopmentPath: process.cwd(), extensionTestsPath, cachePath: path.join(tmpdir(), 'codex-deck-vscode-test'),
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, CODEX_DECK_TEST_CATALOG_DELAY_MS: '2000', CODEX_DECK_TEST_HISTORY_SCAN_DELAY_MS: '2000' },
    launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
