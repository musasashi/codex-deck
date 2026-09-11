import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

/** Remote extension hosts do not necessarily inherit variables from interactive shell startup files. */
export async function appServerEnvironment(base: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<NodeJS.ProcessEnv> {
  const env = { ...base };
  if (env.HF_TOKEN || platform === 'win32') return env;
  try {
    const shell = env.SHELL || userInfo().shell || '/bin/sh';
    // Read only this credential, from the user's home directory. Never log shell output:
    // startup files may print secrets, including on stderr or when the shell fails.
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(shell, ['-i', '-c', 'printf \'\\0CODEX_DECK_HF_TOKEN\\0%s\\0\' "$HF_TOKEN"'],
        { cwd: homedir(), env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.end();
    });
    const marker = '\0CODEX_DECK_HF_TOKEN\0';
    const start = stdout.lastIndexOf(marker);
    const end = stdout.indexOf('\0', start + marker.length);
    if (start >= 0 && end > start + marker.length) env.HF_TOKEN = stdout.slice(start + marker.length, end);
  } catch { /* An unavailable or slow shell must not prevent OpenAI tasks from connecting. */ }
  return env;
}
