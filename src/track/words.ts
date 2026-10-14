export interface WordWindow {
  /** The word containing the caret, with its passage offset. */
  current: { text: string; start: number };
  /** True when the caret sits on the space after the current word. */
  caretOnSpace: boolean;
  next: string[];
}

/** Splits the passage into words and returns the one at `caret` plus the following ones. */
export function wordWindow(passage: string, caret: number, nextCount = 3): WordWindow {
  const words: { text: string; start: number }[] = [];
  let start = 0;
  for (const text of passage.split(' ')) {
    words.push({ text, start });
    start += text.length + 1;
  }
  const pos = Math.max(0, Math.min(caret, passage.length));
  // A word owns its trailing space, so the caret on a space stays on that word.
  let i = words.findIndex((w) => pos <= w.start + w.text.length);
  if (i === -1) i = words.length - 1;
  const current = words[i];
  return {
    current,
    caretOnSpace: pos === current.start + current.text.length && pos < passage.length,
    next: words.slice(i + 1, i + 1 + nextCount).map((w) => w.text),
  };
}
