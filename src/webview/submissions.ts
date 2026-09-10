import { array, object, type Attachment, type Input, type Task } from '../core/types';

export interface Submission { id: string; text: string; skillPaths: string[]; attachments: Attachment[]; optimistic: boolean }
export interface PendingSend extends Submission {
  state: 'sending' | 'sent' | 'failed' | 'unknown';
  turnId?: string;
  seenUserMessageIds: string[];
}

export function submissionContent(submission: Submission): Input[] {
  return [...(submission.text.trim() ? [{ type: 'text' as const, text: submission.text }] : []), ...submission.attachments.map(attachment => attachment.input)];
}

export function pendingSubmission(submission: Submission, task: Task): PendingSend {
  const turn = task.turns.find(turn => turn.id === task.activeTurnId);
  return { ...submission, state: 'sending', turnId: task.activeTurnId,
    seenUserMessageIds: turn?.items.filter(item => item.kind === 'userMessage').map(item => item.id) ?? [] };
}

function inputKey(value: unknown): string {
  const input = object(value);
  return JSON.stringify([input.type, input.type === 'text' ? input.text : input.type === 'image' ? input.url : input.path]);
}

export function reconcilePendingSends(pending: PendingSend[], task: Task): PendingSend[] {
  if (!pending.length) return pending;
  const messages = task.turns.flatMap(turn => turn.items.filter(item => item.kind === 'userMessage').map(item => ({ turnId: turn.id, item })));
  const matched = new Map<string, Set<string>>();
  const remaining = pending.filter(submission => {
    const content = submissionContent(submission).map(inputKey);
    const match = messages.find(({ turnId, item }) => {
      if (matched.get(turnId)?.has(item.id)) return false;
      if (item.data.clientId === submission.id) return true;
      // Steered messages have no client ID. Match only new input in the active turn,
      // allowing the host to append resolved skills and referenced task context.
      if (item.data.clientId || turnId !== submission.turnId || submission.seenUserMessageIds.includes(item.id)) return false;
      const received = array(item.data.content).map(inputKey);
      return content.length > 0 && content.every((input, index) => input === received[index]);
    });
    if (!match) return true;
    if (!matched.has(match.turnId)) matched.set(match.turnId, new Set());
    matched.get(match.turnId)!.add(match.item.id);
    return false;
  });
  return remaining.map(submission => {
    const ids = submission.turnId ? matched.get(submission.turnId) : undefined;
    // Remember consumed messages across renders and reloads so identical queued
    // inputs each wait for their own server message.
    return ids ? { ...submission, seenUserMessageIds: [...new Set([...submission.seenUserMessageIds, ...ids])] } : submission;
  });
}
