import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { appServerEnvironment } from '../src/appServer/environment';
import { StdioConnection } from '../src/appServer/rpc';

const unix = { skip: process.platform === 'win32' };

async function fixture(t: TestContext, script: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-deck-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fixture-shell');
  await writeFile(executable, `#!/usr/bin/env node\n${script}`, { mode: 0o700 });
  return { directory, executable, env: { ...process.env, HF_TOKEN: undefined, SHELL: executable } };
}

test('inherited credentials take precedence and Windows does not launch a shell', async () => {
  const base = { HF_TOKEN: 'hf_inherited', SHELL: '/does/not/exist', PATH: '/original/path' };
  const env = await appServerEnvironment(base, 'linux');
  assert.deepEqual(env, base);
  assert.notEqual(env, base, 'each connection receives its own environment');
  assert.deepEqual(await appServerEnvironment({ SHELL: '/does/not/exist' }, 'win32'), { SHELL: '/does/not/exist' });
});

test('a non-login interactive bash loads guarded .bashrc credentials and only imports HF_TOKEN', unix, async t => {
  const f = await fixture(t, String.raw`
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const child = spawnSync('/bin/bash', ['--noprofile', '--rcfile', path.join(__dirname, '.bashrc'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(child.status ?? 1);
`);
  const rc = path.join(f.directory, '.bashrc');
  await writeFile(rc, `case $- in *i*) ;; *) return ;; esac
printf 'startup banner\\n'
printf 'private startup diagnostic\\n' >&2
export HF_TOKEN='hf_from_bashrc'
export CODEX_DECK_SHELL_ONLY='do not import'
export PATH='/shell/modified/path'
`);
  const base = { ...f.env, CODEX_DECK_SHELL_ONLY: 'original' };
  assert.deepEqual(await appServerEnvironment(base), { ...base, HF_TOKEN: 'hf_from_bashrc' });
  assert.equal(base.HF_TOKEN, undefined, 'do not modify the extension host environment');
  await writeFile(rc, "export HF_TOKEN='hf_updated'\n");
  assert.equal((await appServerEnvironment(base)).HF_TOKEN, 'hf_updated', 'read again on the next connection');
});

test('shell resolution runs at home and ignores unframed startup output', unix, async t => {
  const f = await fixture(t, `
if (process.cwd() !== ${JSON.stringify(homedir())}) process.exit(1);
process.stdout.write('\\0CODEX_DECK_HF_TOKEN\\0hf_at_home\\0');
`);
  assert.equal((await appServerEnvironment(f.env)).HF_TOKEN, 'hf_at_home');
  await writeFile(f.executable, `#!/usr/bin/env node
process.stdout.write('HF_TOKEN=hf_not_a_shell_result\\n');
`);
  assert.deepEqual(await appServerEnvironment(f.env), f.env);
});

test('failed, missing and stalled shells preserve the original environment without exposing their output', unix, async t => {
  const f = await fixture(t, String.raw`
process.stdout.write('\0CODEX_DECK_HF_TOKEN\0hf_failed\0');
process.stderr.write('private shell diagnostic');
process.exit(1);
`);
  assert.deepEqual(await appServerEnvironment(f.env), f.env);
  const missing = { ...f.env, SHELL: path.join(f.directory, 'missing-shell') };
  assert.deepEqual(await appServerEnvironment(missing), missing);
  await writeFile(f.executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  assert.deepEqual(await appServerEnvironment(f.env), f.env);
});

test('App Server receives resolved credentials through its environment without putting them in arguments or logs', async t => {
  const f = await fixture(t, '');
  await writeFile(path.join(f.directory, 'app-server'), String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: {
    token: process.env.HF_TOKEN, args: process.argv.slice(1), cwd: process.cwd()
  } }) + '\n');
});
`);
  const logs: string[] = [];
  const connection = new StdioConnection(text => logs.push(text));
  try {
    const env = await appServerEnvironment({ ...f.env, HF_TOKEN: 'hf_child_fixture' });
    const peer = connection.start(process.execPath, f.directory, env);
    const result = await peer.request('test/environment') as { token: string; args: string[]; cwd: string };
    assert.equal(result.token, 'hf_child_fixture');
    assert.equal(result.cwd, f.directory);
    assert.equal(path.basename(result.args[0]!), 'app-server');
    assert.ok(!result.args.some(arg => arg.includes('hf_child_fixture')));
    assert.deepEqual(logs, []);
  } finally { connection.dispose(); }
});
