export function selectedTranscriptText(transcript: HTMLElement): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  if (!transcript.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
  const text = selection.toString();
  return text.trim() ? text : undefined;
}

export function bindSelectionContext(transcript: HTMLElement, taskId: () => string | undefined): void {
  // Capture the text before VS Code reads the native menu's context, which also
  // becomes the command argument. Later selection changes cannot alter it.
  document.addEventListener('contextmenu', () => {
    const text = selectedTranscriptText(transcript);
    const id = taskId();
    transcript.dataset.vscodeContext = JSON.stringify(text && id
      ? { codexDeckHasSelection: true, codexDeckTaskId: id, codexDeckSelectionText: text }
      : { codexDeckHasSelection: false });
  }, true);
}
