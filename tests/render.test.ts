import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAttachments, renderItem, renderMarkdown } from '../src/webview/render';
import { chatHtml } from '../src/ui/html';
import { taskReferenceText } from '../src/core/taskReferenceText';

test('model text cannot inject executable HTML or navigate using command links', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n[run](command:deleteEverything)\n\n![remote](https://host/image.png)');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="command:'));
  assert.ok(html.includes('data-link="command:deleteEverything"'));
  assert.ok(!html.includes('src="https://host'));
});

test('tool output, automatic labels and native code fences render without raw HTML', () => {
  const code = renderMarkdown('```ts\nconst value = "<unsafe>";\n```');
  assert.match(code, /<div class="code-block"><pre><code class="language-ts">const value = &quot;&lt;unsafe&gt;&quot;;<\/code><\/pre>/);
  assert.match(code, /class="code-copy" data-code-action="copy" aria-label="コードをコピー"/);
  assert.ok(!code.includes('<unsafe>'));
  assert.ok(renderItem({ id: 'i', kind: 'userMessage', data: { content: [{ type: 'text', text: '<script>bad()</script>' }] } }, true).includes('自動送信'));
  assert.ok(!renderItem({ id: 'i', kind: 'commandExecution', data: { command: '<script>', aggregatedOutput: '<script>' } }, false).includes('<script>'));
  const html = renderItem({ id: 'answer', kind: 'userMessage', data: { content: [{ type: 'text', text: '> <script>質問</script>\n> 2行目\n> \n> 補足\n\n**回答**\n\n> 次の質問\n\n```text\n> 回答内のコード\n```' }] } }, false);
  assert.match(html, /<blockquote class="user-quote">&lt;script&gt;質問&lt;\/script&gt;\n2行目\n\n補足<\/blockquote>/);
  assert.match(html, /<div class="user-text">\*\*回答\*\*<\/div>/);
  assert.match(html, /<blockquote class="user-quote">次の質問<\/blockquote>/);
  assert.match(html, /<div class="user-text">```text\n&gt; 回答内のコード\n```<\/div>/);
  assert.doesNotMatch(html, /<script>|<strong>|<pre>/);
});

test('automatic references render outside the original user bubble and keep literal user markers visible', () => {
  const text = taskReferenceText('codex://threads/literal-user-input', '/tmp/<script>.md');
  const html = renderItem({ id: 'user', kind: 'userMessage', data: { content: [
    { type: 'text', text },
    { type: 'text', text: taskReferenceText('codex://threads/first', '/tmp/first/conversation.md') },
    { type: 'text', text: taskReferenceText('codex://threads/second', '/tmp/second/conversation.md') },
  ] } }, false);
  assert.match(html, /class="user-text">[\s\S]*literal-user-input[\s\S]*&lt;script&gt;\.md/);
  assert.equal((html.match(/class="user-text"/g) ?? []).length, 1);
  assert.match(html, /<\/div><\/div><details class="message-references" data-item="references:user">/);
  assert.match(html, /参照情報 · 2件（Codex Deckが自動追加）/);
  assert.equal((html.match(/class="reference-text"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<script>|<codex_deck_reference>/);
});

test('webview CSP disables network, raw HTML scripts and command execution', () => {
  const html = chatHtml({ cspSource: 'test:', script: 'test:/webview.js', css: 'test:/chat.css', nonce: 'nonce' });
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("script-src 'nonce-nonce'"));
  assert.ok(!html.includes('unsafe-inline'));
  assert.ok(html.includes('使用量回復後に自動継続'));
});

test('attached and sent images render inline thumbnails without loading external or executable content', () => {
  const url = 'data:image/png;base64,YQ==';
  const html = renderAttachments([{ id: 'image', label: '<screenshot>', input: { type: 'image', url } },
    { id: 'file', label: '<file>', input: { type: 'text', text: 'file content' } }]);
  assert.ok(html.includes(`src="${url}"`));
  assert.ok(html.includes('alt="&lt;screenshot&gt;"'));
  assert.ok(html.includes('type="button" data-remove="image"'));
  assert.ok(html.includes('&lt;file&gt;'));
  assert.ok(!html.includes('<screenshot>'));
  assert.ok(renderItem({ id: 'user', kind: 'userMessage', data: { content: [{ type: 'image', url }] } }, false).includes(`src="${url}"`));
  for (const unsafe of ['https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YQ==" onerror="alert(1)']) {
    const input = { type: 'image' as const, url: unsafe };
    assert.ok(!renderAttachments([{ id: 'image', label: '画像', input }]).includes('<img'));
    assert.ok(!renderItem({ id: 'user', kind: 'userMessage', data: { content: [input] } }, false).includes('<img'));
  }
});
