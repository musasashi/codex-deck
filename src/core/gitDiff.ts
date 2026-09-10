import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const maxBuffer = 16 * 1024 * 1024;

export async function workingDiff(cwd: string): Promise<string> {
  const git = async (args: string[], diffExit = false): Promise<string> => {
    try { return (await exec('git', args, { cwd, maxBuffer })).stdout; }
    catch (error) {
      const result = error as { code?: number; stdout?: string };
      if (diffExit && result.code === 1 && typeof result.stdout === 'string') return result.stdout;
      throw error;
    }
  };
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--relative'];
  // An unborn branch has staged additions but no HEAD to compare against.
  const hasHead = await git(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  let diff = hasHead ? await git(['diff', ...flags, 'HEAD', '--'])
    : await git(['diff', ...flags, '--cached', '--']) + await git(['diff', ...flags, '--']);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of untracked) {
    // Git recognizes /dev/null on all supported platforms, including Git for Windows.
    diff += await git(['diff', '--no-index', ...flags, '--', '/dev/null', file], true);
    if (Buffer.byteLength(diff) > maxBuffer) throw new Error('差分が大きすぎます。VS Codeのソース管理でファイルごとに確認してください。');
  }
  return diff;
}
