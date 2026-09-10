import { object, type ExecutionMode, type Skill } from './types';

export const permissionPresets: { id: ExecutionMode; label: string; description: string }[] = [
  { id: 'workspace-write', label: 'Ask for approval', description: 'ワークスペース外の編集やインターネットへのアクセスを承認する。' },
  { id: 'auto-review', label: 'Approve for me', description: '承認が必要な操作を自動レビューする。' },
  { id: 'danger-full-access', label: 'Full Access', description: 'サンドボックスと承認確認を使用しない。' },
];

export function permissionMode(sandbox: unknown, reviewer: unknown, policy: unknown): ExecutionMode | undefined {
  if (sandbox === 'readOnly' || sandbox === 'read-only' || sandbox === ':read-only') return 'read-only';
  if ((sandbox === 'dangerFullAccess' || sandbox === 'danger-full-access' || sandbox === ':danger-full-access') && policy === 'never') return 'danger-full-access';
  if ((sandbox === 'workspaceWrite' || sandbox === 'workspace-write' || sandbox === ':workspace') && policy === 'on-request') {
    if (reviewer === 'auto_review' || reviewer === 'guardian_subagent') return 'auto-review';
    if (reviewer === 'user' || reviewer == null) return 'workspace-write';
  }
  return undefined;
}

export function configPermissionMode(value: unknown): ExecutionMode | undefined {
  const config = object(object(value).config);
  const sandbox = config.sandbox_mode ?? config.default_permissions;
  // config/read returns configured values, not the effective defaults for a new thread.
  if (sandbox == null) return 'default';
  return permissionMode(sandbox, config.approvals_reviewer, config.approval_policy);
}

export function permissionOptions(selected: ExecutionMode, inherited?: ExecutionMode): { id: string; label: string }[] {
  const values = permissionPresets.map(preset => ({ id: selected === 'default' && preset.id === inherited ? 'default' : preset.id as string, label: preset.label }));
  if (selected === 'default' && !values.some(value => value.id === 'default')) values.unshift({ id: 'default', label: inherited === 'read-only' ? 'Read Only' : inherited === 'default' ? 'Permissions' : 'Custom' });
  if (selected === 'read-only') values.unshift({ id: 'read-only', label: 'Read Only' });
  return values;
}

export const slashCommands = [
  { name: 'model', description: 'モデルと推論の強さを選択' },
  { name: 'permissions', description: 'Codexの権限を選択' },
  { name: 'skills', description: '登録されたスキルを選択' },
  { name: 'review', description: '作業ツリーをレビュー' },
  { name: 'new', description: '新しいチャットを開始' },
  { name: 'clear', description: '新しいチャットを開始' },
  { name: 'resume', description: '保存されたチャットを開く' },
  { name: 'fork', description: '現在のチャットを分岐' },
  { name: 'rename', description: '現在のチャットの名前を変更' },
  { name: 'archive', description: '現在のチャットをアーカイブ' },
  { name: 'compact', description: '会話を圧縮' },
  { name: 'diff', description: 'Gitの変更差分を表示' },
  { name: 'mention', description: 'ファイルのパスを挿入' },
  { name: 'status', description: '設定と使用量を表示' },
  { name: 'mcp', description: 'MCPサーバーとツールを表示' },
  { name: 'init', description: 'AGENTS.mdを作成' },
  { name: 'copy', description: '直近の応答をコピー' },
  { name: 'logout', description: 'サインアウト' },
  { name: 'quit', description: '現在のタブを閉じる' },
  { name: 'exit', description: '現在のタブを閉じる' },
] as const;

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1]!, args: match[2]?.trim() ?? '' } : undefined;
}

export interface CompletionQuery { kind: 'command' | 'file' | 'skill'; query: string; start: number; end: number }
export function completionQuery(text: string, caret: number, selectionEnd = caret): CompletionQuery | undefined {
  if (selectionEnd !== caret) return;
  const before = text.slice(0, caret);
  if (/^\/[a-z-]*$/i.test(before)) return { kind: 'command', query: before.slice(1), start: 0, end: caret + (/^[a-z-]*/i.exec(text.slice(caret))?.[0].length ?? 0) };
  const match = /(?:^|[\s([{])([@$])("[^"\n]*|[^\s@$"'`\]})]*)$/.exec(before);
  if (!match) return;
  const tail = match[2]!.startsWith('"') ? /^[^"\n]*"?/.exec(text.slice(caret)) : /^[^\s@$"'`\]})]*/.exec(text.slice(caret));
  return { kind: match[1] === '@' ? 'file' : 'skill', query: match[2]!.replace(/^"/, ''), start: caret - match[2]!.length - 1, end: caret + (tail?.[0].length ?? 0) };
}

export function insertCompletion(text: string, query: Pick<CompletionQuery, 'start' | 'end'>, value: string): { text: string; caret: number } {
  const trailing = text.slice(query.end);
  const inserted = value + (/^\s/.test(trailing) ? '' : ' ');
  return { text: text.slice(0, query.start) + inserted + trailing, caret: query.start + inserted.length };
}

export function fileMention(path: string): string { return /\s|"/.test(path) ? JSON.stringify(path) : path; }

export function hasSkillMention(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s([{])\\$${escaped}(?=$|[^\\p{L}\\p{N}_.:/-])`, 'u').test(text);
}

export function resolveSkillMentions(text: string, skills: Skill[], selectedPaths: string[]): Skill[] {
  return skills.filter(skill => hasSkillMention(text, skill.name) && (selectedPaths.includes(skill.path)
    || (!skills.some(other => other.name === skill.name && selectedPaths.includes(other.path)) && skills.filter(other => other.name === skill.name).length === 1)));
}
