// The reserved markers an Agent's final answer opens with (see @usine/agents).
const MARKER = /^\s*\[usine:(blocked|question)\]/u;

/** The reserved marker an Agent message opens with: a blocker, an operator question, or none. */
export const answerMarker = (text: string): "blocked" | "question" | null => {
  const marker = MARKER.exec(text)?.[1];
  return marker === "blocked" || marker === "question" ? marker : null;
};

/** The message as the reader shows it: the reserved opening marker is protocol, not prose. */
export const withoutMarker = (text: string): string => text.replace(MARKER, "").trimStart();

/** Text compared for repetition, so a copy that differs only in its marker or spacing is the same message. */
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

/** Markdown as plain running text, for previews that clamp to a few lines. */
export const previewText = (text: string): string =>
  text
    .replace(/```[\s\S]*?(?:```|$)/gu, "\n")
    .split("\n")
    .map(plainLine)
    .filter((line) => line !== "")
    .join(" ");

/**
 * Names a message by its own first sentence, as plain text on one line. Code blocks
 * and Markdown syntax are left out; a first line without sentence punctuation is used whole.
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
