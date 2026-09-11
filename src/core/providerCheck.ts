export type ProviderCheckPurpose = 'task' | 'title';
export interface ProviderCheck {
  model: string;
  purpose: ProviderCheckPurpose;
  status: 'checking' | 'passed' | 'failed';
  message: string;
}
export function providerCheckKey(model: string, purpose: ProviderCheckPurpose): string { return `${purpose}:${model}`; }
