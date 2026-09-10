import test from 'node:test';
import assert from 'node:assert/strict';
import { completionQuery, configPermissionMode, fileMention, hasSkillMention, insertCompletion, parseSlashCommand, permissionMode, permissionOptions, resolveSkillMentions } from '../src/core/composer';

test('completion recognizes CLI triggers at the caret without treating emails, paths or selections as commands', () => {
  assert.deepEqual(completionQuery('/per', 4), { kind: 'command', query: 'per', start: 0, end: 4 });
  assert.equal(completionQuery('Check @src/main', 15)?.query, 'src/main');
  assert.equal(completionQuery('Use\n$plugin:skill', 17)?.kind, 'skill');
  for (const text of ['user@example.com', 'https://example.com/a', '/tmp/file', 'price $10 USD', 'hello/']) assert.equal(completionQuery(text, text.length), undefined);
  assert.equal(completionQuery('@file', 0, 5), undefined);
  assert.equal(completionQuery('/model extra', 12), undefined);
});

test('file insertion removes the marker, quotes spaces and preserves surrounding text and cursor positions', () => {
  const text = '確認 @src/main.ts を読んで';
  const query = completionQuery(text, text.indexOf('main') + 2)!;
  const result = insertCompletion(text, query, fileMention('src/new file.ts'));
  assert.equal(result.text, '確認 "src/new file.ts" を読んで');
  assert.equal(result.text.slice(0, result.caret), '確認 "src/new file.ts"');
  const quoted = '@"docs/資料 old.md" を確認';
  const next = insertCompletion(quoted, completionQuery(quoted, 9)!, fileMention('docs/資料 new.md'));
  assert.equal(next.text, '"docs/資料 new.md" を確認');
  assert.equal(fileMention('src/main.ts'), 'src/main.ts');
  assert.equal(fileMention('a"b.ts'), '"a\\"b.ts"');
});

test('explicit skills are selected by path, resolve unique typed names and do not match longer names', () => {
  const first = { name: 'sample', path: '/one/SKILL.md', description: 'one', scope: 'user' };
  const second = { ...first, path: '/two/SKILL.md' };
  assert.equal(hasSkillMention('Use $sample-other', 'sample'), false);
  assert.equal(hasSkillMention('Use $sample日本語', 'sample'), false);
  assert.equal(hasSkillMention('Use ($sample)', 'sample'), true);
  assert.equal(hasSkillMention('$plugin:skill を使用', 'plugin:skill'), true);
  assert.deepEqual(resolveSkillMentions('$sample を使用', [first, second], [second.path]), [second]);
  assert.deepEqual(resolveSkillMentions('$sample を使用', [first, second], []), []);
  assert.deepEqual(resolveSkillMentions('$sample を使用', [first], []), [first]);
  assert.deepEqual(resolveSkillMentions('スキル指定を削除した', [first], [first.path]), []);
});

test('slash command arguments are separated and absolute file paths remain normal input', () => {
  assert.deepEqual(parseSlashCommand('/rename 日本語のタスク名'), { name: 'rename', args: '日本語のタスク名' });
  assert.deepEqual(parseSlashCommand('/review\n追加の指示'), { name: 'review', args: '追加の指示' });
  assert.deepEqual(parseSlashCommand('/unknown'), { name: 'unknown', args: '' });
  assert.equal(parseSlashCommand('/tmp/file.md を読んで'), undefined);
});

test('CLI permission labels reflect actual inherited policies without converting Custom or Read Only to a preset', () => {
  assert.equal(configPermissionMode({ config: { sandbox_mode: null, default_permissions: null, approval_policy: null, approvals_reviewer: 'user' } }), 'default');
  assert.equal(configPermissionMode({ config: { sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'auto_review' } }), 'auto-review');
  assert.equal(configPermissionMode({ config: { default_permissions: ':workspace', approval_policy: 'on-request' } }), 'workspace-write');
  assert.equal(permissionMode('dangerFullAccess', 'user', 'on-request'), undefined);
  assert.equal(permissionMode('workspaceWrite', 'user', 'never'), undefined);
  assert.equal(permissionMode('readOnly', 'user', 'never'), 'read-only');
  assert.deepEqual(permissionOptions('default', 'auto-review'), [
    { id: 'workspace-write', label: 'Ask for approval' }, { id: 'default', label: 'Approve for me' }, { id: 'danger-full-access', label: 'Full Access' },
  ]);
  assert.deepEqual(permissionOptions('default')[0], { id: 'default', label: 'Custom' });
  assert.deepEqual(permissionOptions('default', 'read-only')[0], { id: 'default', label: 'Read Only' });
  assert.deepEqual(permissionOptions('default', 'default')[0], { id: 'default', label: 'Permissions' });
});
