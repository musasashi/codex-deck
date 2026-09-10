import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUsage } from '../src/core/usage';
import { decodeUsage } from '../src/appServer/client';
import { usage } from './helpers';

test('quota window lengths identify weekly-only accounts independently of the primary slot', () => {
  const value = decodeUsage({ rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 12.5, windowDurationMins: 10_080, resetsAt: 2_000_000_000 }, secondary: null } });
  assert.deepEqual(value.buckets[0]!.windows, [{ key: 'primary', usedPercent: 12.5, windowDurationMins: 10_080, resetsAt: 2_000_000_000_000 }]);
  const invalid = decodeUsage({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: -1, resetsAt: NaN }, secondary: { usedPercent: NaN, windowDurationMins: 300 } } });
  assert.deepEqual(invalid.buckets[0]!.windows, [{ key: 'primary', usedPercent: 20, windowDurationMins: undefined, resetsAt: undefined }]);
});

test('all blocking windows must recover and reset dates only schedule reads', () => {
  const value = usage(100);
  value.buckets[0]!.windows.push({ key: 'secondary', usedPercent: 100, resetsAt: 20_000 });
  const first = evaluateUsage(value, [], 1000);
  assert.equal(first.recovered, false); assert.equal(first.recoveryAt, 20_000); assert.equal(first.nextCheckAt, 10_000);
  value.buckets[0]!.windows[0]!.usedPercent = 5;
  assert.equal(evaluateUsage(value, first.blockers, 30_000).recovered, false);
  value.buckets[0]!.windows[1]!.usedPercent = 5;
  assert.equal(evaluateUsage(value, first.blockers, 30_000).recovered, true);
});

test('missing bucket or spend-control state cannot be mistaken for recovery', () => {
  const value = usage(10); value.buckets[0]!.spendControlReached = true;
  const first = evaluateUsage(value);
  delete value.buckets[0]!.spendControlReached;
  assert.equal(evaluateUsage(value, first.blockers).recovered, false);
  value.buckets[0]!.spendControlReached = false;
  assert.equal(evaluateUsage(value, first.blockers).recovered, true);
  assert.equal(evaluateUsage({ buckets: [] }, first.blockers).recovered, false);
});

test('new bucket IDs and individual limits are decoded without hardcoded catalog values', () => {
  const value = decodeUsage({ rateLimitsByLimitId: { future: { limitId: 'future', primary: { usedPercent: 20, resetsAt: 123 }, individualLimit: { remainingPercent: 0, resetsAt: 456 }, spendControlReached: true, addedField: 'ignored' } } });
  assert.equal(value.buckets[0]?.id, 'future');
  assert.equal(value.buckets[0]?.windows[0]?.resetsAt, 123_000);
  assert.equal(evaluateUsage(value, [], 0).recovered, false);
});

test('workspace credits block on the reported limit state; no add-on credits alone is not a quota error', () => {
  const decode = (reached: string | null) => decodeUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10 }, rateLimitReachedType: reached, credits: { hasCredits: false, unlimited: false } } });
  const blocked = evaluateUsage(decode('workspace_owner_credits_depleted'));
  assert.equal(blocked.recovered, false);
  assert.equal(evaluateUsage(decode(null), blocked.blockers).recovered, true);
});

test('an unrecognized backend limit-state shape cannot clear an existing blocker', () => {
  const value = decodeUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 5 }, rateLimitReachedType: { future: true } } });
  assert.equal(evaluateUsage(value, ['codex:reached']).recovered, false);
});
