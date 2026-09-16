import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestionPresets, validateQuestionPresets, questionPresetMessage, type QuestionPreset } from '../src/core/questionPresets';
import { DEFAULT_PRESET } from '../src/core/settings';
import { providerModels, validateProviders } from '../src/core/providers';
import { FakeGateway } from './helpers';

const question: QuestionPreset = { id: 'explain', name: 'かみ砕いて', prompt: '具体例で説明してください。', settings: { ...DEFAULT_PRESET } };

test('question settings validate independently, preserving ordering and external model prices', async () => {
  const providers = validateProviders([{ id: 'local', name: 'Local', baseUrl: 'http://localhost/v1', models: [{ id: 'model', reasoningEfforts: ['low'] }] }]);
  const models = [...await new FakeGateway().listModels(), ...providerModels(providers)];
  const configured = [question,
    { ...question, id: 'hf', settings: { model: 'hf:org/model', effort: 'default', mode: 'read-only', pricing: { input: 1, output: 2 } } },
    { ...question, id: 'api', settings: { model: 'responses:local:model', effort: 'low', mode: 'workspace-write' } },
  ];
  const valid = validateQuestionPresets(configured, models);
  assert.deepEqual(valid, configured);
  valid[0]!.settings.model = 'test-model';
  assert.equal(question.settings.model, 'latest');
  assert.deepEqual(readQuestionPresets(undefined), []);
  assert.deepEqual(validateQuestionPresets([], models), []);
});

test('invalid questions and model settings are rejected without replacing them with defaults', async () => {
  const models = await new FakeGateway().listModels();
  for (const invalid of [
    { ...question, id: '' }, { ...question, name: ' ' }, { ...question, prompt: '\n' },
    { ...question, settings: {} }, { ...question, settings: { ...question.settings, model: 'missing' } },
    { ...question, settings: { ...question.settings, effort: 'unsupported' } },
    { ...question, settings: { ...question.settings, mode: 'bad' } },
    { ...question, settings: { model: 'hf:org/model', effort: 'default', mode: 'read-only', pricing: { input: -1, output: 1 } } },
  ]) assert.throws(() => validateQuestionPresets([invalid], models), /質問プリセット1/);
  assert.throws(() => validateQuestionPresets([question, { ...question, id: ' explain ' }], models), /重複/);
  assert.throws(() => validateQuestionPresets({}, models), /配列/);
  assert.equal(readQuestionPresets([{ ...question, settings: { model: 'missing' } }])[0]?.settings.model, 'missing');
});

test('a question quotes exact selected text and includes its source link without interpreting slash commands', () => {
  const text = '  <tag>\n\n> 引用\n  run();';
  const message = questionPresetMessage({ ...question, prompt: '/new を説明してください。' }, text, { title: '元\n会話', link: 'codex://threads/source' });
  assert.equal(message, '質問: /new を説明してください。\n\n> 参照元: 会話「元 会話」\n>\n>   <tag>\n> \n> > 引用\n>   run();\n\n元の会話: codex://threads/source');
  assert.throws(() => questionPresetMessage(question, ' ', { title: '', link: '' }), /範囲選択/);
  assert.throws(() => questionPresetMessage(question, 'a'.repeat(2 * 1024 * 1024), { title: '', link: '' }), /大きすぎ/);
});
