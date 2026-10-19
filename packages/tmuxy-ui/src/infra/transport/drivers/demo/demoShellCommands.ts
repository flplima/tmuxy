/**
 * The little a demo shell understands of a command line: words split the
 * way a shell splits them (quotes, backslashes, a `>` redirect), and `printf`.
 */

export interface ParsedLine {
  argv: string[];
  /** The file after `>`, or null when the output goes to the terminal. */
  redirect: string | null;
}

export function parseLine(line: string): ParsedLine {
  const words: string[] = [];
  let redirect: string | null = null;
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  let redirecting = false;
  const end = () => {
    if (word === null) return;
    if (redirecting) {
      redirect = word;
      redirecting = false;
    } else words.push(word);
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(line[i + 1] ?? '')) word += line[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (ch === '\\') {
      word = (word ?? '') + (line[++i] ?? '');
    } else if (ch === '>') {
      end();
      redirecting = true;
    } else if (/\s/.test(ch)) {
      end();
    } else {
      word = (word ?? '') + ch;
    }
  }
  end();
  return { argv: words, redirect };
}

/** `printf FORMAT ARGS…`: `%s` takes the next argument, `%%` and `\n`/`\t`/`\\` are themselves. */
export function printf(format: string, args: string[]): string {
  let next = 0;
  return format.replace(/%%|%s|\\[nt\\]/g, (token) => {
    switch (token) {
      case '%%':
        return '%';
      case '%s':
        return args[next++] ?? '';
      case '\\n':
        return '\n';
      case '\\t':
        return '\t';
      default:
        return '\\';
    }
  });
}
