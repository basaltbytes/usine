// The reserved markers at the start of an Agent's final answer (see @usine/agents).
const MARKER = /^\s*\[usine:(blocked|question|failed|provider-capacity)\]/u;

/** Returns the `blocked` or `question` marker at the start of an Agent message, or `null`. */
export const answerMarker = (text: string): "blocked" | "question" | null => {
  const marker = MARKER.exec(text)?.[1];
  return marker === "blocked" || marker === "question" ? marker : null;
};

export const withoutMarker = (text: string): string => text.replace(MARKER, "").trimStart();

/** Returns text for duplicate detection, ignoring the marker and whitespace differences. */
export const comparableText = (text: string): string =>
  withoutMarker(text).replace(/\s+/gu, " ").trim();

const plainLine = (line: string): string =>
  line
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/gu, "$1$2")
    .trim();

/** Returns Markdown as plain text on one line, without code blocks. */
export const previewText = (text: string): string =>
  text
    .replace(/```[\s\S]*?(?:```|$)/gu, "\n")
    .split("\n")
    .map(plainLine)
    .filter((line) => line !== "")
    .join(" ");

/**
 * Returns the message's first sentence as plain text, without code blocks or Markdown syntax. If the
 * first line has no sentence punctuation, returns the whole line.
 */
export const checkpointText = (text: string): string => {
  const lines = withoutMarker(text)
    .replace(/```[\s\S]*?(?:```|$)/gu, "\n")
    .split("\n")
    .map(plainLine)
    .filter((line) => line !== "");
  const first = lines[0] ?? "";
  return /^(.*?[.!?…])(?=\s|$)/u.exec(first)?.[1] ?? first;
};

// Characters per outline row at 13px, and the minimum length of a clause used as a label.
const LABEL_LENGTH = 32;
const CLAUSE_LENGTH = 12;

/**
 * Shortens `sentence` to `LABEL_LENGTH` characters without cutting a word: returns its first clause
 * if that fits, otherwise its first words and an ellipsis.
 */
export const checkpointLabel = (sentence: string): string => {
  if (sentence.length <= LABEL_LENGTH) return sentence;
  const clause = /^(.+?)(?:[,;:]\s|\s[—–-]\s)/u.exec(sentence)?.[1];
  if (clause !== undefined && clause.length >= CLAUSE_LENGTH && clause.length <= LABEL_LENGTH)
    return clause;
  const boundary = sentence.slice(0, LABEL_LENGTH + 1).lastIndexOf(" ");
  const words = boundary > 0 ? sentence.slice(0, boundary) : (sentence.split(" ")[0] ?? sentence);
  return `${words.replace(/[\s,;:.—–-]+$/u, "")}…`;
};
