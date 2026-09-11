import test from 'node:test';
import assert from 'node:assert/strict';
import { addTaskCost, costLabel, costSample, emptyTaskCost, readTokenPrice, validateTokenPrice } from '../src/core/cost';

const usage = (input: number, output: number, lastInput = input, lastOutput = output) => ({
  total: { inputTokens: input, outputTokens: output }, last: { inputTokens: lastInput, outputTokens: lastOutput },
});
const price = { input: 2, output: 5 };

test('token prices require explicit finite, nonnegative numbers and preserve a free rate', () => {
  assert.deepEqual(validateTokenPrice({ input: 0, output: 0.125 }), { input: 0, output: 0.125 });
  for (const value of [undefined, {}, { input: '2', output: 5 }, { input: -1, output: 5 }, { input: 0, output: NaN }, { input: Infinity, output: 1 }]) {
    assert.equal(readTokenPrice(value), undefined);
    assert.throws(() => validateTokenPrice(value), /単価/);
  }
});

test('task costs deduplicate cumulative usage, persist baselines, and apply price edits only to later usage', () => {
  const first = costSample('thread', usage(1_000_000, 200_000), price)!;
  let cost = addTaskCost(emptyTaskCost(), first);
  assert.equal(cost.usd, 3);
  assert.equal(addTaskCost(cost, first), cost);
  cost = JSON.parse(JSON.stringify(cost));
  assert.equal(addTaskCost(cost, first).usd, 3);
  cost = addTaskCost(cost, costSample('thread', usage(2_000_000, 400_000, 1_000_000, 200_000), { input: 10, output: 20 })!);
  assert.equal(cost.usd, 17);
  cost = addTaskCost(cost, costSample('title-thread', usage(1000, 20), price)!);
  assert.equal(cost.usd, 17.0021);
  assert.equal(cost.unpricedTokens, 0);
});

test('forks exclude inherited turns and count only new usage even when counters contain parent history', () => {
  let cost = emptyTaskCost(false, ['parent-turn']);
  cost = addTaskCost(cost, costSample('fork', usage(1_000_000, 200_000), price, 'parent-turn')!);
  assert.equal(cost.usd, 0);
  cost = addTaskCost(cost, costSample('fork', usage(1_001_000, 200_020, 1000, 20), price, 'new-turn')!);
  assert.equal(cost.usd, 0.0021);
  const noInitialEvent = addTaskCost(emptyTaskCost(), costSample('fork', usage(1_001_000, 200_020, 1000, 20), price, 'new-turn')!);
  assert.equal(noInitialEvent.usd, 0.0021);
});

test('counter resets count the latest response and missing prices do not appear as free usage', () => {
  let cost = addTaskCost(emptyTaskCost(), costSample('thread', usage(1_000_000, 0), price)!);
  cost = addTaskCost(cost, costSample('thread', usage(1000, 20), price)!);
  assert.equal(cost.usd, 2.0021);
  cost = addTaskCost(cost, costSample('unpriced', usage(500, 50))!);
  assert.equal(cost.unpricedTokens, 550);
  assert.match(costLabel(cost).label, /一部/);
  assert.match(costLabel(cost).detail, /550トークン/);
  assert.equal(costLabel(addTaskCost(emptyTaskCost(), costSample('unpriced', usage(10, 0))!)).label, '費用 未計上');
  assert.equal(costLabel(emptyTaskCost()).label, '$0.0000（概算）');
  assert.match(costLabel(emptyTaskCost(true)).detail, /計測開始前/);
  assert.equal(costLabel({ ...emptyTaskCost(), usd: 0.000001 }).label, '<$0.0001（概算）');
});

test('invalid usage cannot turn missing counts into zeros or non-finite amounts', () => {
  for (const invalid of [undefined, {}, usage(-1, 1), usage(Infinity, 0), usage(1.5, 2), { total: { inputTokens: 5, outputTokens: 2 } }]) {
    assert.equal(costSample('thread', invalid, price), undefined);
  }
  const cost = addTaskCost(emptyTaskCost(), costSample('large', usage(Number.MAX_SAFE_INTEGER, 0), { input: Number.MAX_VALUE, output: 0 })!);
  assert.equal(cost.usd, 0);
  assert.equal(cost.unpricedTokens, Number.MAX_SAFE_INTEGER);
});
