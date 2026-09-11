import { execFile } from 'node:child_process';
import { homedir, release, userInfo } from 'node:os';
import { ENV_NAME } from '../core/providers';

export function requireWslHost(remoteName: string | undefined, platform = process.platform, kernelRelease = release()): void {
  // Local Extension Hosts used for development also run directly inside WSL.
  const wsl = platform === 'linux' && (remoteName === 'wsl' || (remoteName === undefined && /microsoft/i.test(kernelRelease)));
  if (!wsl) throw new Error('Codex DeckはWSL内のCodex専用です。VS Codeで作業フォルダーをWSL接続で開き、Codex Deckと公式Codex CLIをWSL側にインストールしてください。');
}

/** WSL extension hosts do not necessarily inherit variables from interactive shell startup files. */
export async function appServerEnvironment(base: NodeJS.ProcessEnv = process.env, keys = ['HF_TOKEN']): Promise<NodeJS.ProcessEnv> {
  const env = { ...base };
  if (keys.some(key => !ENV_NAME.test(key))) throw new Error('APIキーの環境変数名が不正です。');
  const missing = [...new Set(keys)].filter(key => !env[key]);
  if (!missing.length) return env;
  try {
    const shell = env.SHELL || userInfo().shell || '/bin/sh';
    // Read only configured credentials, from the user's home directory. Never log shell output:
    // startup files may print secrets, including on stderr or when the shell fails.
    const stdout = await new Promise<string>((resolve, reject) => {
      const command = `printf '${missing.map(key => `\\0CODEX_DECK_${key}\\0%s\\0`).join('')}' ${missing.map(key => `"$${key}"`).join(' ')}`;
      const child = execFile(shell, ['-i', '-c', command],
        { cwd: homedir(), env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.end();
    });
    for (const key of missing) {
      const marker = `\0CODEX_DECK_${key}\0`;
      const start = stdout.lastIndexOf(marker);
      const end = stdout.indexOf('\0', start + marker.length);
      if (start >= 0 && end > start + marker.length) env[key] = stdout.slice(start + marker.length, end);
    }
  } catch { /* An unavailable or slow shell must not prevent OpenAI tasks from connecting. */ }
  return env;
}
