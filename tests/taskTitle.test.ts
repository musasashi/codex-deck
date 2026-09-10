import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '../src/core/taskManager';
import { parseTitle, provisionalTitle, titleInput } from '../src/core/taskTitle';
import type { Attachment, TitleRequest, TitleSource, Turn } from '../src/core/types';
import { deferred, FakeGateway, thread } from './helpers';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(model: string | ((cwd: string) => string) = 'title-model', titleEffort?: (cwd: string) => string) {
  const gateway = new FakeGateway();
  const requests: { request: TitleRequest; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
  gateway.generateTitle = async (request, signal) => {
    const result = deferred<string>(); requests.push({ request, signal, result }); return result.promise;
  };
  const manager = new TaskManager(gateway, { async save() {} }, [], { schedule: false, titleModel: typeof model === 'string' ? () => model : model, titleEffort });
  return { gateway, manager, requests };
}

function conversation(): Turn[] {
  return ['初期画面を作成', 'ログインエラーを修正', '通知機能を追加'].map((text, index) => ({
    id: `history-${index}`, status: 'completed', items: [
      { id: `user-${index}`, kind: 'userMessage', data: { content: [{ type: 'text', text }] } },
      { id: `reply-${index}`, kind: 'agentMessage', data: { text: `${text}の対応内容` } },
    ],
  }));
}

test('forks wait for the first new instruction and summarize it with the selected history without changing the source', async () => {
  for (const lastTurnId of ['history-1', undefined]) {
    const { gateway, manager, requests } = setup('title-model', () => 'high');
    try {
      const source = { ...thread('source'), turns: conversation() };
      gateway.threads.set(source.id, source);
      const original = manager.adoptThread(structuredClone(source));
      await manager.rename(original.id, '元タスクの手動名');
      const before = structuredClone(original);
      const forked = await manager.fork(original.id, lastTurnId); await tick();
      assert.notEqual(forked.threadId, original.threadId);
      assert.equal(forked.title, '分岐したタスク');
      assert.equal(gateway.threads.get(forked.threadId!)?.name, forked.title);
      assert.equal(forked.status, 'idle');
      assert.equal(forked.busy, false);
      assert.equal(forked.unreadTurnId, undefined);
      assert.equal(forked.autoResume, false);
      assert.deepEqual(gateway.sent, [], 'fork naming must not send a turn into either conversation');
      assert.equal(requests.length, 0, 'forking alone must not generate a title');
      const expectedTurns = structuredClone(source.turns.slice(0, lastTurnId ? 2 : 3));
      assert.deepEqual(forked.turns, expectedTurns);
      const instruction = 'この修正の仕様ドキュメントを作成して';
      manager.attach(forked.id, { id: 'doc', label: 'SPEC.md', input: { type: 'text', text: '既存の仕様書' } });
      await manager.send(forked.id, instruction); await tick();
      assert.equal(requests.length, 1);
      assert.equal(forked.busy, false, 'sending must not wait for the summary');
      assert.equal(forked.status, 'running');
      assert.equal(gateway.sent.length, 1);
      gateway.events.emit({ type: 'name', threadId: forked.threadId!, title: '分岐したタスク' });
      assert.equal(requests[0]!.signal.aborted, false, 'a repeated placeholder notification must not cancel naming');
      const request = requests[0]!.request;
      assert.equal(request.model, 'title-model');
      assert.equal(request.effort, 'high');
      assert.equal(request.cwd, '/project');
      assert.match(request.input, /初期画面を作成/);
      assert.match(request.input, /ログインエラーを修正の対応内容/);
      assert.equal(JSON.parse(request.input).request, instruction);
      assert.match(request.input, /SPEC.md/);
      assert.match(request.input, /既存の仕様書/);
      assert.doesNotMatch(JSON.stringify(JSON.parse(request.input).conversation), /仕様ドキュメント/, 'the new request is separate from inherited history');
      assert.doesNotMatch(request.input, /元タスクの手動名/);
      if (lastTurnId) assert.doesNotMatch(request.input, /通知機能/);
      else assert.match(request.input, /通知機能を追加の対応内容/);
      const title = lastTurnId ? 'ログイン修正の仕様書を作成' : '通知機能の仕様書を作成';
      await manager.send(forked.id, '補足です'); await tick();
      assert.equal(requests.length, 1, 'follow-ups must not duplicate an in-flight title job');
      requests[0]!.result.resolve(title); await tick();
      assert.equal(forked.title, title);
      assert.equal(forked.titleSource, 'generated');
      assert.equal(gateway.threads.get(forked.threadId!)?.name, title);
      assert.equal(manager.records().find(record => record.id === forked.id)?.titleGenerationAttempted, true);
      assert.deepEqual(original, before);
      assert.equal(gateway.threads.get(source.id)?.name, before.title);
      assert.deepEqual(forked.turns.slice(0, expectedTurns.length), expectedTurns);
      await manager.send(forked.id, '続けてください'); await tick();
      assert.equal(requests.length, 1);
      assert.equal(forked.title, title);
    } finally { manager.dispose(); await manager.flush(); }
  }
});

test('a fork restored before its first send uses the new instruction and inherited context to name the task', async () => {
  const { gateway, manager, requests } = setup();
  const source = { ...thread('source'), title: 'Claude枠とDeepSeek API対応可否', name: 'Claude枠とDeepSeek API対応可否', turns: [
    { id: 'design', status: 'completed', items: [
      { id: 'question', kind: 'userMessage', data: { content: [{ type: 'text', text: 'DeepSeek APIはどのような設計になる？' }] } },
      { id: 'answer', kind: 'agentMessage', data: { text: 'DeepSeek対応でもCodex App Serverを継続利用し、接続先ごとに会話管理と残高表示を分けます。' } },
    ] },
  ] };
  gateway.threads.set(source.id, source);
  const forked = await manager.fork(manager.adoptThread(source).id);
  const records = manager.records();
  manager.dispose(); await manager.flush();
  const restored = new TaskManager(gateway, { async save() {} }, records, { schedule: false, titleModel: () => 'title-model' });
  try {
    await restored.restore(forked.id);
    await restored.send(forked.id, '  '); await tick();
    assert.equal(restored.get(forked.id).title, '分岐したタスク');
    assert.equal(requests.length, 0, 'restoring or an empty send must not start inference');
    await restored.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0]!.request.input).request, 'この修正の仕様ドキュメントを作成して');
    assert.match(requests[0]!.request.input, /DeepSeek対応でもCodex App Serverを継続利用/);
    assert.doesNotMatch(requests[0]!.request.input, /Claude枠/);
    requests[0]!.result.resolve('DeepSeek API対応の仕様書を作成'); await tick();
    assert.equal(restored.get(forked.id).title, 'DeepSeek API対応の仕様書を作成');
    assert.equal(gateway.threads.get(forked.threadId!)?.name, 'DeepSeek API対応の仕様書を作成');
  } finally { restored.dispose(); await restored.flush(); }
});

test('saved unresolved fork placeholders recover on send while explicit manual and generated names stay protected', async () => {
  for (const titleSource of ['provisional', 'existing', undefined, 'manual', 'generated'] as (TitleSource | undefined)[]) {
    const { gateway, manager, requests } = setup();
    const source = { ...thread('source'), turns: conversation() };
    gateway.threads.set(source.id, source);
    const forked = await manager.fork(manager.adoptThread(source).id);
    const records = manager.records();
    Object.assign(records.find(record => record.id === forked.id)!, { titleSource, titleGenerationAttempted: true });
    manager.dispose(); await manager.flush();
    const restored = new TaskManager(gateway, { async save() {} }, records, { schedule: false, titleModel: () => 'title-model' });
    try {
      await restored.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
      if (titleSource === 'manual' || titleSource === 'generated') {
        assert.equal(requests.length, 0);
        assert.equal(restored.get(forked.id).title, '分岐したタスク');
      } else {
        assert.equal(requests.length, 1);
        requests[0]!.result.resolve('通知機能の仕様書を作成'); await tick();
        assert.equal(restored.get(forked.id).title, '通知機能の仕様書を作成');
      }
    } finally { restored.dispose(); await restored.flush(); }
  }
});

test('manually naming a fork before its first send cancels automatic naming even when the placeholder is chosen', async () => {
  for (const name of ['自分で決めた名前', '分岐したタスク']) {
    const { gateway, manager, requests } = setup();
    try {
      const source = { ...thread('source'), turns: conversation() };
      gateway.threads.set(source.id, source);
      const forked = await manager.fork(manager.adoptThread(source).id);
      await manager.rename(forked.id, name);
      await manager.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
      assert.equal(requests.length, 0);
      assert.equal(forked.title, name);
    } finally { manager.dispose(); await manager.flush(); }
  }
});

test('a failed first send on a fork starts naming only after the request is successfully retried', async () => {
  const { gateway, manager, requests } = setup();
  try {
    const source = { ...thread('source'), turns: conversation() };
    gateway.threads.set(source.id, source);
    const forked = await manager.fork(manager.adoptThread(source).id);
    gateway.turnStarter = async () => { throw new Error('送信失敗'); };
    await assert.rejects(manager.send(forked.id, 'この修正の仕様ドキュメントを作成して'), /送信失敗/); await tick();
    assert.equal(requests.length, 0);
    gateway.turnStarter = undefined;
    await manager.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
    assert.equal(requests.length, 1);
    requests[0]!.result.resolve('通知機能の仕様書を作成'); await tick();
    assert.equal(forked.title, '通知機能の仕様書を作成');
  } finally { manager.dispose(); await manager.flush(); }
});

test('a manual fork name wins over a pending summary and survives reload', async () => {
  const { gateway, manager, requests } = setup();
  try {
    const source = { ...thread('source'), name: '元の名前', turns: conversation() };
    gateway.threads.set(source.id, source);
    const forked = await manager.fork(manager.adoptThread(source).id, 'history-1'); await tick();
    await manager.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
    await manager.rename(forked.id, '分岐先の手動名');
    assert.equal(requests[0]!.signal.aborted, true);
    requests[0]!.result.resolve('遅れて届いた要約'); await tick();
    const restored = new TaskManager(gateway, { async save() {} }, manager.records(), { schedule: false, titleModel: () => 'title-model' });
    try {
      await restored.restore(forked.id);
      assert.equal(restored.get(forked.id).title, '分岐先の手動名');
      assert.equal(restored.get(forked.id).titleSource, 'manual');
      assert.equal(gateway.threads.get(source.id)?.name, '元の名前');
    } finally { restored.dispose(); await restored.flush(); }
  } finally { manager.dispose(); await manager.flush(); }
});

test('a failed fork summary retries on the next user send after reload', async () => {
  const { gateway, manager, requests } = setup();
  const errors: string[] = []; manager.errors.subscribe(error => errors.push(error));
  try {
    const source = { ...thread('source'), name: '元の名前', turns: conversation() };
    gateway.threads.set(source.id, source);
    const forked = await manager.fork(manager.adoptThread(source).id); await tick();
    await manager.send(forked.id, 'この修正の仕様ドキュメントを作成して'); await tick();
    requests[0]!.result.reject(new Error('timeout')); await tick();
    assert.equal(forked.title, '分岐したタスク');
    assert.equal(forked.status, 'running');
    assert.equal(forked.error, undefined);
    assert.match(errors[0]!, /タスク名の要約.*timeout/);
    const restored = new TaskManager(gateway, { async save() {} }, manager.records(), { schedule: false, titleModel: () => 'title-model' });
    try {
      await restored.restore(forked.id);
      assert.equal(restored.get(forked.id).title, '分岐したタスク');
      await restored.send(forked.id, '続けてください'); await tick();
      assert.equal(requests.length, 2);
      assert.equal(JSON.parse(requests[1]!.request.input).request, '続けてください');
      requests[1]!.result.resolve('通知機能の仕様書を作成'); await tick();
      assert.equal(restored.get(forked.id).title, '通知機能の仕様書を作成');
      assert.equal(gateway.threads.get(source.id)?.name, '元の名前');
    } finally { restored.dispose(); await restored.flush(); }
  } finally { manager.dispose(); await manager.flush(); }
});

test('forks without conversation content generate a title only after their first request', async () => {
  const { manager, requests } = setup();
  try {
    const forked = await manager.fork(manager.create('/project').id); await tick();
    assert.equal(forked.title, '分岐したタスク');
    assert.equal(requests.length, 0);
    await manager.send(forked.id, '新しい依頼'); await tick();
    assert.equal(requests.length, 1);
    requests[0]!.result.resolve('新しい依頼の要約'); await tick();
    assert.equal(forked.title, '新しい依頼の要約');
  } finally { manager.dispose(); await manager.flush(); }
});

test('first send runs immediately, titles use their own model and preserve attachment context and task state', async () => {
  const { gateway, manager, requests } = setup();
  try {
    const task = manager.create('/workspace', { model: 'test-model', mode: 'workspace-write' });
    manager.attach(task.id, { id: 'file', label: 'src/login.ts', input: { type: 'text', text: 'Error: invalid token' } });
    await manager.send(task.id, 'ログインできません\n修正してください。');
    await tick();
    assert.equal(task.title, 'ログインできません');
    assert.equal(task.busy, false);
    assert.equal(task.status, 'running');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.request.model, 'title-model');
    assert.equal(requests[0]!.request.effort, 'lowest');
    assert.equal(requests[0]!.request.cwd, '/workspace');
    assert.match(requests[0]!.request.input, /src\/login.ts/);
    assert.match(requests[0]!.request.input, /invalid token/);
    assert.equal(gateway.sent[0]!.settings.model, 'test-model');
    const turnId = task.activeTurnId;
    await manager.send(task.id, '補足です');
    requests[0]!.result.resolve('ログイン時のトークンエラーを修正');
    await tick();
    assert.equal(task.title, 'ログイン時のトークンエラーを修正');
    assert.equal(task.titleSource, 'generated');
    assert.equal(gateway.threads.get(task.threadId!)?.name, task.title);
    assert.equal(manager.records()[0]!.titleGenerationAttempted, true);
    assert.equal(task.activeTurnId, turnId);
    assert.equal(task.status, 'running');
    assert.equal(task.unreadTurnId, undefined);
    assert.equal(requests.length, 1);
  } finally { manager.dispose(); await manager.flush(); }
});

test('manual names win while generation is pending and remain protected after restore', async () => {
  const { gateway, manager, requests } = setup();
  try {
    const task = manager.create('/project');
    await manager.send(task.id, 'original request'); await tick();
    await manager.rename(task.id, '自分で決めた名前');
    assert.equal(requests[0]!.signal.aborted, true);
    requests[0]!.result.resolve('Late generated title'); await tick();
    assert.equal(task.title, '自分で決めた名前');
    assert.equal(task.titleSource, 'manual');
    assert.equal(gateway.threads.get(task.threadId!)?.name, task.title);
    const restored = new TaskManager(gateway, { async save() {} }, manager.records(), { schedule: false, titleModel: () => 'title-model' });
    try {
      await restored.restore(task.id);
      await restored.send(task.id, 'follow up'); await tick();
      assert.equal(restored.get(task.id).title, '自分で決めた名前');
      assert.equal(requests.length, 1);
    } finally { restored.dispose(); await restored.flush(); }
  } finally { manager.dispose(); await manager.flush(); }
});

test('a manual rename is saved after an already in-flight automatic name write', async () => {
  const { gateway, manager, requests } = setup();
  const writing = deferred<void>();
  const names: string[] = [];
  const rename = gateway.renameThread.bind(gateway);
  gateway.renameThread = async (id, name) => {
    names.push(name);
    if (name === 'Generated') await writing.promise;
    await rename(id, name);
  };
  try {
    const task = manager.create('/project');
    await manager.send(task.id, 'request'); await tick();
    requests[0]!.result.resolve('Generated'); await tick();
    const manual = manager.rename(task.id, 'Manual'); await tick();
    assert.deepEqual(names, ['Generated']);
    writing.resolve(); await manual; await tick();
    assert.deepEqual(names, ['Generated', 'Manual']);
    assert.equal(task.title, 'Manual');
    assert.equal(gateway.threads.get(task.threadId!)?.name, 'Manual');
  } finally { manager.dispose(); await manager.flush(); }
});

test('existing threads and drafts named before their first send are not automatically renamed', async () => {
  const { gateway, manager, requests } = setup();
  try {
    const existing = { ...thread('existing'), name: '既存の名前', title: '既存の名前' };
    gateway.threads.set(existing.id, existing);
    const task = manager.adoptThread(existing);
    await manager.send(task.id, 'new request');
    const draft = manager.create('/project');
    await manager.rename(draft.id, '新規タスク');
    await manager.send(draft.id, 'request'); await tick();
    assert.equal(task.title, '既存の名前');
    assert.equal(draft.title, '新規タスク');
    assert.equal(draft.titleSource, 'manual');
    assert.equal(requests.length, 0);
  } finally { manager.dispose(); await manager.flush(); }
});

test('generation errors preserve the fallback, do not fail the task, and are not retried after restart', async () => {
  const { gateway, manager, requests } = setup();
  const errors: string[] = []; manager.errors.subscribe(error => errors.push(error));
  try {
    const task = manager.create('/project');
    await manager.send(task.id, 'original request\nsecond line'); await tick();
    requests[0]!.result.reject(new Error('timeout')); await tick();
    assert.equal(task.title, 'original request');
    assert.equal(task.status, 'running');
    assert.equal(task.error, undefined);
    assert.match(errors[0]!, /タスク名の要約.*timeout/);
    const restored = new TaskManager(gateway, { async save() {} }, manager.records(), { schedule: false, titleModel: () => 'title-model' });
    try {
      await restored.restore(task.id);
      assert.equal(restored.get(task.id).title, 'original request');
      await restored.send(task.id, 'follow up'); await tick();
      assert.equal(requests.length, 1);
    } finally { restored.dispose(); await restored.flush(); }
  } finally { manager.dispose(); await manager.flush(); }
});

test('parallel tasks receive the right titles and pick up their configured model and effort at their first send', async () => {
  const configured = new Map([['/one', 'old-model'], ['/two', 'second-model']]);
  const efforts = new Map([['/one', 'lowest'], ['/two', 'low']]);
  const { gateway, manager, requests } = setup(cwd => configured.get(cwd)!, cwd => efforts.get(cwd)!);
  try {
    const first = manager.create('/one'); const second = manager.create('/two');
    configured.set('/one', 'new-model');
    efforts.set('/one', 'high');
    await Promise.all([manager.send(first.id, 'one'), manager.send(second.id, 'two')]); await tick();
    assert.equal(requests.find(job => job.request.cwd === '/one')!.request.model, 'new-model');
    assert.equal(requests.find(job => job.request.cwd === '/two')!.request.model, 'second-model');
    assert.equal(requests.find(job => job.request.cwd === '/one')!.request.effort, 'high');
    assert.equal(requests.find(job => job.request.cwd === '/two')!.request.effort, 'low');
    efforts.set('/one', 'lowest');
    assert.equal(requests.find(job => job.request.cwd === '/one')!.request.effort, 'high');
    assert.equal(first.settings.effort, undefined);
    requests.find(job => job.request.cwd === '/two')!.result.resolve('Two'); await tick();
    requests.find(job => job.request.cwd === '/one')!.result.resolve('One'); await tick();
    assert.equal(first.title, 'One'); assert.equal(second.title, 'Two');
    assert.equal(gateway.threads.get(first.threadId!)?.name, 'One');
    assert.equal(gateway.threads.get(second.threadId!)?.name, 'Two');
  } finally { manager.dispose(); await manager.flush(); }
});

test('external names, disconnection and disposal cancel title jobs and ignore their late results', async () => {
  for (const action of ['external', 'disconnect', 'dispose']) {
    const { gateway, manager, requests } = setup();
    try {
      const task = manager.create('/project');
      await manager.send(task.id, 'original'); await tick();
      if (action === 'external') await gateway.renameThread(task.threadId!, 'External');
      else if (action === 'disconnect') gateway.events.emit({ type: 'connection', connected: false });
      else manager.dispose();
      assert.equal(requests[0]!.signal.aborted, true);
      requests[0]!.result.resolve('Late'); await tick();
      assert.equal(task.title, action === 'external' ? 'External' : 'original');
    } finally { manager.dispose(); await manager.flush(); }
  }
});

test('title input is bounded, excludes image data and preserves Unicode titles', () => {
  const attachments: Attachment[] = [{ id: 'image', label: 'image.png', input: { type: 'image', url: 'data:image/png;base64,PRIVATE_IMAGE' } },
    ...Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `file${i}`, input: { type: 'text' as const, text: 'x'.repeat(10000) } }))];
  const input = titleInput('a'.repeat(20000), attachments);
  assert.ok(input.length < 10000);
  assert.doesNotMatch(input, /PRIVATE_IMAGE/);
  assert.equal(JSON.parse(input).attachments.length, 5);
  assert.equal(provisionalTitle('', attachments), 'image.png');
  assert.equal(provisionalTitle('😀'.repeat(90), []), '😀'.repeat(80));
  assert.equal(parseTitle('{"title":"  タスク名  を整理  "}'), 'タスク名 を整理');
  assert.equal(parseTitle(JSON.stringify({ title: '😀'.repeat(40) })), '😀'.repeat(40));
  for (const invalid of ['not JSON', '{}', '{"title":" "}', '{"title":123}', JSON.stringify({ title: 'x'.repeat(41) })]) assert.throws(() => parseTitle(invalid));
});

test('fork title context keeps recent messages in order and omits tool output, commentary and image data', () => {
  const turns = conversation();
  const last = turns.at(-1)!;
  last.items.splice(1, 0,
    { id: 'tools', kind: 'commandExecution', data: { aggregatedOutput: 'PRIVATE_TOOL_OUTPUT' } },
    { id: 'reasoning', kind: 'reasoning', data: { text: 'PRIVATE_REASONING' } },
    { id: 'progress', kind: 'agentMessage', data: { phase: 'commentary', text: 'PROGRESS_ONLY' } },
    { id: 'attachments', kind: 'userMessage', data: { content: [
      { type: 'text', text: '追加の資料' },
      { type: 'image', url: 'data:image/png;base64,PRIVATE_IMAGE' },
      { type: 'localImage', path: '/project/screenshot.png' },
      { type: 'skill', name: 'review' },
    ] } },
  );
  const input = titleInput('この修正の仕様ドキュメントを作成して', [], turns);
  assert.doesNotMatch(input, /PRIVATE_|PROGRESS_ONLY|data:image/);
  assert.match(input, /追加の資料/);
  assert.match(input, /screenshot\.png/);
  assert.match(input, /\$review/);
  const messages = JSON.parse(input).conversation;
  assert.deepEqual(messages[0], { role: 'user', text: '初期画面を作成' });
  assert.deepEqual(messages.at(-1), { role: 'assistant', text: '通知機能を追加の対応内容' });
  const longHistory = Array.from({ length: 20 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', items: [
    { id: `user-${index}`, kind: 'userMessage', data: { content: [{ type: 'text', text: `依頼${index}:` + 'x'.repeat(10000) }] } },
    { id: `reply-${index}`, kind: 'agentMessage', data: { text: `応答${index}:` + 'y'.repeat(10000) } },
  ] }));
  const bounded = titleInput('この修正の仕様ドキュメントを作成して', [], longHistory);
  assert.ok(bounded.length < 10000);
  assert.doesNotMatch(bounded, /依頼0:/);
  assert.match(bounded, /依頼19:/);
  assert.match(bounded, /応答19:/);
  const recent = JSON.parse(bounded).conversation as { text: string }[];
  assert.ok(recent.every(message => message.text.length <= 2000));
  assert.ok(recent.reduce((sum, message) => sum + message.text.length, 0) <= 6000);
  assert.equal(JSON.parse(bounded).request, 'この修正の仕様ドキュメントを作成して');
  assert.deepEqual(JSON.parse(titleInput('新しい依頼', [], [])).conversation, []);
});
