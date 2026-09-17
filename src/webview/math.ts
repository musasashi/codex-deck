import katex from 'katex';
import type { TokenizerAndRendererExtension } from 'marked';

function mathToken(source: string, block: boolean) {
  const opening = source.match(block ? /^ {0,3}(\\\[|\$\$)/ : /^(\\\[|\\\(|\$\$|\$)/);
  if (!opening) return;
  const delimiter = opening[1]!;
  const closing = delimiter === '\\[' ? '\\]' : delimiter === '\\(' ? '\\)' : delimiter;
  for (let index = opening[0].length; index < source.length; index++) {
    if (delimiter === '$' && source[index] === '\n') return;
    if (source.startsWith(closing, index)) {
      const text = source.slice(opening[0].length, index);
      if (!text.trim()) return;
      // Whitespace and a following digit distinguish common currency text from math.
      if (delimiter === '$' && (/^\s|\s$/.test(text) || /\d/.test(source[index + 1] ?? ''))) return;
      let end = index + closing.length;
      if (block) {
        const trailing = source.slice(end).match(/^[ \t]*(?:\n|$)/);
        if (!trailing) return;
        end += trailing[0].length;
      }
      return { type: block ? 'mathBlock' : 'mathInline', raw: source.slice(0, end), text,
        displayMode: delimiter === '\\[' || delimiter === '$$' };
    }
    // Keep escaped delimiters and LaTeX row breaks inside the formula.
    if (source[index] === '\\') index++;
  }
}

export const mathExtensions: TokenizerAndRendererExtension[] = [true, false].map(block => ({
  name: block ? 'mathBlock' : 'mathInline',
  level: block ? 'block' : 'inline',
  start(source: string) { return source.match(block ? /^ {0,3}(?:\\\[|\$\$)/m : /\\[([]|\$/)?.index; },
  tokenizer(source: string) { return mathToken(source, block); },
  renderer(token) {
    return katex.renderToString(token.text, {
      displayMode: token.displayMode, throwOnError: false, trust: false, strict: 'ignore', maxSize: 20,
    });
  },
}));
