import { object } from './types';

export interface TokenCount { input: number; output: number }
/** USD per one million tokens. */
export interface TokenPrice { input: number; output: number }
export interface CostSample { sourceId: string; turnId?: string; total: TokenCount; last: TokenCount; price?: TokenPrice }
export interface TaskCost {
  usd: number;
  unpricedTokens: number;
  partial: boolean;
  sources: Record<string, TokenCount>;
  excludedTurnIds: string[];
}

export function emptyTaskCost(partial = false, excludedTurnIds: string[] = []): TaskCost {
  return { usd: 0, unpricedTokens: 0, partial, sources: {}, excludedTurnIds };
}

export function readTokenPrice(value: unknown): TokenPrice | undefined {
  const price = object(value);
  return [price.input, price.output].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? { input: price.input as number, output: price.output as number } : undefined;
}

export function validateTokenPrice(value: unknown): TokenPrice {
  const price = readTokenPrice(value);
  if (!price) throw new Error('HFの入力・出力単価を0以上の数値（USD／100万トークン）で入力してください。');
  return price;
}

function tokenCount(value: unknown): TokenCount | undefined {
  const data = object(value);
  return [data.inputTokens, data.outputTokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ? { input: data.inputTokens as number, output: data.outputTokens as number } : undefined;
}

export function costSample(sourceId: string, value: unknown, price?: TokenPrice, turnId?: string): CostSample | undefined {
  const usage = object(value), total = tokenCount(usage.total), last = tokenCount(usage.last);
  return sourceId && total && last ? { sourceId, turnId, total, last, price: readTokenPrice(price) } : undefined;
}

/** Cumulative counters deduplicate notifications and survive reconnects. */
export function addTaskCost(cost: TaskCost, sample: CostSample): TaskCost {
  const previous = Object.hasOwn(cost.sources, sample.sourceId) ? cost.sources[sample.sourceId] : undefined;
  if (previous && sample.total.input === previous.input && sample.total.output === previous.output) return cost;
  if (sample.turnId && cost.excludedTurnIds.includes(sample.turnId)) return { ...cost, sources: { ...cost.sources, [sample.sourceId]: sample.total } };
  const delta = previous && sample.total.input >= previous.input && sample.total.output >= previous.output
    ? { input: sample.total.input - previous.input, output: sample.total.output - previous.output } : sample.last;
  let price = readTokenPrice(sample.price);
  const amount = price ? delta.input / 1_000_000 * price.input + delta.output / 1_000_000 * price.output : 0;
  if (!Number.isFinite(cost.usd + amount)) price = undefined;
  return { ...cost,
    usd: cost.usd + (price ? amount : 0),
    unpricedTokens: cost.unpricedTokens + (price ? 0 : delta.input + delta.output),
    sources: { ...cost.sources, [sample.sourceId]: sample.total },
  };
}

export function costLabel(cost?: TaskCost): { label: string; detail: string } {
  if (!cost) return { label: '費用 未計測', detail: 'このタスクの利用額はまだ計測していません。' };
  const format = (value: number): string => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;
  const amount = format(cost.usd);
  const incomplete = cost.partial || cost.unpricedTokens > 0;
  return {
    label: cost.unpricedTokens > 0 && cost.usd === 0 ? '費用 未計上' : `${amount}（概算${incomplete ? '・一部' : ''}）`,
    detail: ['このタスクのHF利用額（USD）。HFでのタスク名の要約も含みます。',
      '使用トークン数とユーザー設定の単価から計算します。無料クレジット・キャッシュ割引は未反映です。',
      cost.unpricedTokens > 0 ? `単価未設定の${cost.unpricedTokens.toLocaleString('ja-JP')}トークンは未計上です。` : '',
      cost.partial ? '計測開始前の利用額は含みません。' : '',
    ].filter(Boolean).join('\n'),
  };
}
