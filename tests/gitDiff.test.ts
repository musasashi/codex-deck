import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workingDiff } from '../src/core/gitDiff';

test('working diff includes staged, unstaged and untracked changes, respects ignores and leaves the index unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-deck-diff-'));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd });
  try {
    await git(['init', '--quiet']);
    await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(cwd, 'tracked.txt'), 'original\n');
    await git(['add', '.']);
    assert.match(await workingDiff(cwd), /\+original/); // Unborn branch.
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    assert.equal(await workingDiff(cwd), '');
    await writeFile(join(cwd, 'tracked.txt'), 'staged\n');
    await git(['add', 'tracked.txt']);
    await writeFile(join(cwd, 'tracked.txt'), 'staged\nunstaged\n');
    await writeFile(join(cwd, 'new file.txt'), 'untracked\n');
    await writeFile(join(cwd, 'ignored.txt'), 'should not appear\n');
    const before = (await git(['status', '--porcelain'])).stdout;
    const diff = await workingDiff(cwd);
    assert.match(diff, /\+staged/); assert.match(diff, /\+unstaged/); assert.match(diff, /\+untracked/);
    assert.doesNotMatch(diff, /should not appear/);
    assert.equal((await git(['status', '--porcelain'])).stdout, before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
