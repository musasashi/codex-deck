import type { Usage } from './types';

/** A reset time only schedules a read. It is never evidence that usage recovered. */
export function evaluateUsage(usage: Usage, previous: string[] = [], now = Date.now()): {
  recovered: boolean; blockers: string[]; recoveryAt?: number; nextCheckAt?: number;
} {
  const blocked = new Set<string>();
  const recovered = new Set<string>();
  const resetTimes: number[] = [];
  let complete = usage.buckets.length > 0;
  for (const bucket of usage.buckets) {
    complete &&= bucket.complete;
    for (const window of bucket.windows) {
      const key = `${bucket.id}:window:${window.key}`;
      if (window.usedPercent >= 100) {
        blocked.add(key);
        if (window.resetsAt && window.resetsAt > now) resetTimes.push(window.resetsAt);
      } else if (window.usedPercent >= 0) recovered.add(key);
      else complete = false;
    }
    const reached = `${bucket.id}:reached`;
    if (bucket.reached) blocked.add(reached);
    else if (bucket.reachedKnown) recovered.add(reached);
    const spend = `${bucket.id}:spend`;
    if (bucket.spendControlReached === true) blocked.add(spend);
    else if (bucket.spendControlReached === false) recovered.add(spend);
  }
  // Missing buckets/fields never clear a previously observed blocking limit.
  for (const key of previous) if (!recovered.has(key)) blocked.add(key);
  return {
    recovered: complete && blocked.size === 0,
    blockers: [...blocked],
    recoveryAt: resetTimes.length ? Math.max(...resetTimes) : undefined,
    nextCheckAt: resetTimes.length ? Math.min(...resetTimes) : undefined,
  };
}
