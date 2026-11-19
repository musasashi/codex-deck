import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { appServerEnvironment, requireWslHost } from '../src/appServer/environment';
import { StdioConnection } from '../src/appServer/rpc';

test('WSL connections and local WSL development hosts are supported', () => {
  assert.doesNotThrow(() => requireWslHost('wsl', 'linux', 'custom-kernel'));
  assert.doesNotThrow(() => requireWslHost(undefined, 'linux', '4.4.0-19041-Microsoft'));
  assert.doesNotThrow(() => requireWslHost(undefined, 'linux', '6.6.87.2-microsoft-standard-WSL2'));
});

test('unsupported hosts receive WSL setup guidance, including local Windows hosts in a WSL window', () => {
  for (const [remoteName, platform, kernelRelease] of [
    [undefined, 'win32', '10.0.26100'],
    ['wsl', 'win32', '10.0.26100'],
    [undefined, 'darwin', '24.0.0'],
    [undefined, 'linux', '6.8.0-generic'],
    ['ssh-remote', 'linux', '6.8.0-generic'],
    ['ssh-remote', 'linux', '6.6.87.2-microsoft-standard-WSL2'],
    ['dev-container', 'linux', '6.6.87.2-microsoft-standard-WSL2'],
  ] as const) {
    assert.throws(() => requireWslHost(remoteName, platform, kernelRelease), /WSL接続で開き/);
  }
});

const externalEnvironment = {
  OPENAI_API_KEY: 'fixture', CODEX_API_KEY: 'fixture', CODEX_ACCESS_TOKEN: 'fixture', HF_TOKEN: 'fixture',
  OPENAI_BASE_URL: 'https://example.test', CHATGPT_BASE_URL: 'https://example.test',
};

test('the child environment drops external credentials and endpoints without mutating the host', () => {
  const base = { ...externalEnvironment, PATH: '/fixture/bin', SHELL: '/does/not/exist' };
  assert.deepEqual(appServerEnvironment(base), { PATH: base.PATH, SHELL: base.SHELL });
  assert.equal(base.OPENAI_API_KEY, 'fixture');
});

test('App Server starts with the ChatGPT login and official provider and endpoints', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-deck-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'app-server'), String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, params } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id, result: {
    inherited: params.keys.filter(key => Object.hasOwn(process.env, key)), args: process.argv.slice(2), cwd: process.cwd()
  } }) + '\n');
});
`);
  const logs: string[] = [];
  const connection = new StdioConnection(text => logs.push(text));
  t.after(() => connection.dispose());
  const peer = connection.start(process.execPath, directory, { ...process.env, ...externalEnvironment });
  assert.deepEqual(await peer.request('test/environment', { keys: Object.keys(externalEnvironment) }), {
    inherited: [], cwd: directory, args: [
      '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
      '-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"', '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ],
  });
  assert.deepEqual(logs, []);
});
