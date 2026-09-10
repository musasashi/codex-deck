import test from 'node:test';
import assert from 'node:assert/strict';
import { messageMarkdown, taskMarkdown } from '../src/core/taskCopy';

test('individual copies preserve the original message without role labels or UI text', () => {
  const text = '**修正しました。**\n\n```ts\nconst html = "<div>";\n```';
  assert.equal(messageMarkdown({ id: 'answer', kind: 'agentMessage', data: { text } }), text);
  assert.equal(messageMarkdown({ id: 'user', kind: 'userMessage', data: { content: [
    { type: 'text', text: 'この画像を確認してください。\n<details>' }, { type: 'skill', name: 'review' }, { type: 'localImage', path: '/tmp/a b.png' },
  ] } }), 'この画像を確認してください。\n<details>\n\n$review\n\n![添付画像](</tmp/a%20b.png>)');
  assert.equal(messageMarkdown({ id: 'plan', kind: 'plan', data: { text: '- テストする' } }), '- テストする');
  assert.equal(messageMarkdown({ id: 'review', kind: 'exitedReviewMode', data: { review: '問題ありません。' } }), '問題ありません。');
  assert.equal(messageMarkdown({ id: 'command', kind: 'commandExecution', data: { text: 'tool output' } }), undefined);
});

test('Markdown copies the whole conversation in order, preserving message formatting and omitting tool internals', () => {
  const markdown = taskMarkdown({ title: 'コードの修正', turns: [
    { id: 'first', status: 'completed', items: [
      { id: 'user-1', kind: 'userMessage', data: { content: [{ type: 'text', text: '修正してください。\n\n```ts\nconst value = 1;\n```' }] } },
      { id: 'progress', kind: 'agentMessage', data: { phase: 'commentary', text: '確認します。' } },
      { id: 'reasoning', kind: 'reasoning', data: { text: 'internal reasoning' } },
      { id: 'command', kind: 'commandExecution', data: { command: 'tool command', aggregatedOutput: 'tool output' } },
      { id: 'answer-1', kind: 'agentMessage', data: { phase: 'final_answer', text: '**修正しました。**' } },
    ] },
    { id: 'second', status: 'inProgress', items: [
      { id: 'user-2', kind: 'userMessage', data: { content: [{ type: 'text', text: '続けてください。' }] } },
      { id: 'plan', kind: 'plan', data: { text: '- テストする' } },
      { id: 'review', kind: 'exitedReviewMode', data: { review: '問題ありません。' } },
      { id: 'streaming', kind: 'agentMessage', data: { text: '追加の確認中です。' } },
    ] },
  ] });
  assert.equal(markdown, [
    '# コードの修正',
    '## ユーザー\n\n修正してください。\n\n```ts\nconst value = 1;\n```',
    '## Codex\n\n確認します。',
    '## Codex\n\n**修正しました。**',
    '## ユーザー\n\n続けてください。',
    '## Codex\n\n- テストする',
    '## Codex\n\n問題ありません。',
    '## Codex\n\n追加の確認中です。',
  ].join('\n\n') + '\n');
});

test('Markdown retains image-only inputs and skill mentions, and handles empty tasks', () => {
  assert.equal(taskMarkdown({ title: '新規タスク', turns: [] }), '# 新規タスク\n');
  const markdown = taskMarkdown({ title: '[画像]\n*確認*', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', kind: 'userMessage', data: { content: [
      { type: 'image', url: 'data:image/png;base64,YQ==' },
      { type: 'localImage', path: '/tmp/image (1).png' },
      { type: 'image' },
      { type: 'skill', name: 'review' },
    ] } },
    { id: 'empty', kind: 'agentMessage', data: { text: '' } },
    { id: 'answer', kind: 'agentMessage', data: { text: '確認しました。' } },
  ] }] });
  assert.equal(markdown, '# \\[画像\\] \\*確認\\*\n\n## ユーザー\n\n![添付画像](<data:image/png;base64,YQ==>)\n\n![添付画像](</tmp/image%20(1).png>)\n\n（添付画像）\n\n$review\n\n## Codex\n\n確認しました。\n');
});
