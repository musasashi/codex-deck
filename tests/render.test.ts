import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAttachments, renderItem, renderMarkdown } from '../src/webview/render';
import { chatHtml } from '../src/ui/html';
import { taskReferenceText } from '../src/core/taskReferenceText';
import { inducedVoltageAnswer } from './fixtures/math';

test('the reported induced-voltage answer renders fractions and all three aligned equations', () => {
  const html = renderMarkdown(inducedVoltageAnswer);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.equal((html.match(/<mfrac>/g) ?? []).length, 2);
  assert.match(html, /<mtable/);
  for (const phase of ['u', 'v', 'w']) assert.ok(html.includes(`e_${phase} &amp;\\approx`));
  assert.match(html, /<strong>50 ms<\/strong>/);
  assert.doesNotMatch(html, /katex-error/);
});

test('inline and display delimiters work in paragraphs, lists and tables without Markdown altering TeX', () => {
  const html = renderMarkdown(String.raw`周波数は \(f_e = 20\ \mathrm{Hz}\)、周期は $T = 1/f_e$ です。
\[a_b + c_d\]
$$\frac{1}{2}$$

- **電圧**: $e_u$ と \(e_v\)

| 信号 | 値 |
| --- | --- |
| $e_w$ | \(5.10\) |`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 8);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.match(html, /<li><strong>電圧<\/strong>/);
  assert.match(html, /<td><span class="katex">/);
  assert.doesNotMatch(html, /<em>|katex-error/);
  assert.doesNotMatch(renderMarkdown(String.raw`$\text{cost: \$5}$`), /katex-error/);
});

test('code, escaped delimiters and currency remain literal', () => {
  const html = renderMarkdown([
    '`\\(x\\)` と `$x$`、`$$x$$`、`\\[x\\]`',
    '```tex\n\\[x\\]\n$$x$$\n```',
    '    $$x$$',
    String.raw`\\(literal\\) と \$5、価格は $5 と $10 です。`,
  ].join('\n\n'));
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /<code>\\\(x\\\)<\/code>/);
  assert.ok(html.includes('価格は $5 と $10 です。'));
});

test('partial and invalid math do not prevent the rest of a message from rendering', () => {
  const partial = '\\[\n\\frac{600}{60}';
  assert.doesNotMatch(renderMarkdown(partial), /class="katex/);
  assert.match(renderMarkdown(`${partial}\n\\]`), /class="katex-display"/);
  const invalid = renderMarkdown('\\[\\frac{1}{\\]\n\n**後続の説明**');
  assert.match(invalid, /class="katex-error"/);
  assert.match(invalid, /<strong>後続の説明<\/strong>/);
});

test('math cannot introduce executable HTML, links or external resources', () => {
  const html = renderMarkdown(String.raw`\(\href{javascript:alert(1)}{run}\)
\(\includegraphics{https://host/image.png}\)
\(\htmlStyle{background:url(https://host/image.png)}{x}\)
\[\invalid{<img src=x onerror="alert(1)">}\]`);
  assert.doesNotMatch(html, /<a\b|<img\b|<script\b|style="[^"]*url\(/);
  assert.match(html, /&lt;img/);
});

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
  assert.ok(html.includes('style-src test:;'));
  assert.ok(html.includes("style-src-attr 'unsafe-inline';"));
  assert.ok(html.includes('font-src test:;'));
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
