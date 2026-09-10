#!/usr/bin/env node
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const threads = new Map([['history-fixture', { id: 'history-fixture', name: 'History fixture', cwd: process.cwd(), status: { type: 'idle' }, turns: [] }]]);
for (let i = 2; i <= Number(process.env.CODEX_DECK_TEST_HISTORY_COUNT ?? 1); i++) {
  const id = `history-fixture-${i}`;
  threads.set(id, { id, name: `History fixture ${i}`, cwd: process.cwd(), updatedAt: 1700000000 - i, status: { type: 'idle' }, turns: [] });
}
const archived = new Set();
const archiveAttempts = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (process.env.CODEX_DECK_TEST_RPC_LOG) appendFileSync(process.env.CODEX_DECK_TEST_RPC_LOG, JSON.stringify(message) + '\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'codex-deck-test' };
  else if (message.method === 'model/list') result = { data: [{ model: 'test-model', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'test-effort', description: 'test' }, { reasoningEffort: 'high', description: 'high' }], defaultReasoningEffort: 'test-effort', isDefault: true }], nextCursor: null };
  else if (message.method === 'account/read') result = { account: null, requiresOpenaiAuth: false };
  else if (message.method === 'skills/list') result = { data: [{ cwd: message.params.cwds[0], skills: [
    { name: 'fixture-skill', description: 'Registered fixture skill', path: '/fixture/SKILL.md', scope: 'user', enabled: true },
    { name: 'disabled-skill', description: 'Disabled fixture', path: '/disabled/SKILL.md', scope: 'user', enabled: false },
  ] }] };
  else if (message.method === 'config/read') result = { config: { sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'user' } };
  else if (message.method === 'fuzzyFileSearch') result = { files: [{ path: 'src/example file.ts', match_type: 'file', root: message.params.roots[0], file_name: 'example file.ts', score: 100 }] };
  else if (message.method === 'thread/list') {
    const matching = [...threads.values()].filter(thread => archived.has(thread.id) === Boolean(message.params.archived));
    const start = Number(message.params.cursor ?? 0);
    const end = start + message.params.limit;
    result = { data: matching.slice(start, end), nextCursor: end < matching.length ? String(end) : null };
  } else if (message.method === 'thread/archive') {
    const id = message.params.threadId;
    const attempt = (archiveAttempts.get(id) ?? 0) + 1; archiveAttempts.set(id, attempt);
    if (id === process.env.CODEX_DECK_TEST_ARCHIVE_FAIL_ONCE && attempt === 1) {
      send({ id: message.id, error: { code: -32603, message: 'Archive fixture failure' } }); return;
    }
    archived.add(id);
  } else if (message.method === 'thread/unarchive') archived.delete(message.params.threadId);
  else if (message.method === 'thread/start') {
    const thread = { id: `thread-${threads.size + 1}`, cwd: message.params.cwd, status: { type: 'idle' }, preview: '', turns: [] };
    threads.set(thread.id, thread); result = { thread };
  } else if (message.method === 'thread/read' || message.method === 'thread/resume') result = { thread: threads.get(message.params.threadId) };
  else if (message.method === 'turn/start') {
    const thread = threads.get(message.params.threadId);
    const turn = { id: `turn-${thread.turns.length + 1}`, status: 'completed', items: [
      { id: 'user', type: 'userMessage', clientId: message.params.clientUserMessageId, content: message.params.input },
      { id: 'agent', type: 'agentMessage', text: 'Fixture response' },
    ] };
    thread.turns.push(turn); result = { turn };
  }
  else if (message.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 5, resetsAt: 2000000000 }, secondary: null } };
  const delay = message.method === 'thread/archive' ? Number(process.env.CODEX_DECK_TEST_ARCHIVE_DELAY_MS ?? 0)
    : message.method === 'model/list' || message.method === 'account/read'
    ? Number(process.env.CODEX_DECK_TEST_CATALOG_DELAY_MS ?? 0)
    : message.method === 'thread/list' && message.params.useStateDbOnly !== true
      ? Number(process.env.CODEX_DECK_TEST_HISTORY_SCAN_DELAY_MS ?? 0) : 0;
  if (delay) setTimeout(() => send({ id: message.id, result }), delay);
  else send({ id: message.id, result });
});
