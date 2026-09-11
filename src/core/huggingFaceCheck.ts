export type HuggingFaceCheckPurpose = 'task' | 'title';
export interface HuggingFaceCheck {
  model: string;
  purpose: HuggingFaceCheckPurpose;
  status: 'checking' | 'passed' | 'failed';
  message: string;
}

export function huggingFaceCheckKey(model: string, purpose: HuggingFaceCheckPurpose): string { return `${purpose}:${model}`; }
