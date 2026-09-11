import { array, object, string, type PendingRequest, type RequestAnswer, type Task } from './types';

/** Rebuild unanswered message questions from both streamed items and saved history. */
export function messageQuestions(task: Task): PendingRequest[] {
  if (!task.threadId) return [];
  let requests: PendingRequest[] = [];
  const resolved = new Set(task.resolvedQuestionIds);
  for (const turn of task.turns) {
    for (const item of turn.items) {
      // Later user input supersedes questions already present in the conversation.
      if (item.kind === 'userMessage') { requests = []; continue; }
      if (item.kind !== 'agentMessage' || item.data.delivery !== 'async') continue;
      const id = `message:${JSON.stringify([turn.id, item.id])}`;
      if (resolved.has(id)) continue;
      const questions = array(item.data.questions).flatMap((value, index) => {
        const raw = object(value), question = string(raw.title);
        if (!question.trim()) return [];
        return [{ id: String(index), header: '', question, secret: false,
          options: array(raw.options).filter((v): v is string => typeof v === 'string' && !!v.trim()).map(label => ({ label, description: '' })) }];
      });
      if (questions.length) requests.push({ id, threadId: task.threadId, turnId: turn.id, kind: 'questions',
        title: '質問', detail: '', choices: [], questions, blocking: false, source: 'agentMessage' });
    }
  }
  return requests;
}

export function questionAnswers(request: PendingRequest, answer: RequestAnswer): Record<string, string[]> {
  const answers: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  if (answer.skip === true) return answers;
  for (const question of request.questions ?? []) {
    const values = answer.answers?.[question.id];
    if (!Array.isArray(values) || !values.length || !values.every(value => typeof value === 'string' && value.trim())) {
      throw new Error('すべての質問に回答してください。');
    }
    answers[question.id] = values;
  }
  return answers;
}

export function questionAnswerText(request: PendingRequest, answer: RequestAnswer): string {
  const answers = questionAnswers(request, answer);
  return (request.questions ?? []).map(question => {
    const quote = question.question.split(/\r?\n/).map(line => `> ${line}`).join('\n');
    return `${quote}\n\n${answers[question.id]!.join('\n')}`;
  }).join('\n\n');
}
