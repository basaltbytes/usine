import { jsonKey } from "@usine/core/json-key";

/**
 * The most bytes of JSON that a page of a paged operator read holds. A page always holds its first
 * entry, so one entry larger than this makes a larger page.
 */
export const PAGE_BYTES = 20_000;

const encoder = new TextEncoder();

/** Returns the length of `value`'s JSON text in UTF-8 bytes. */
export const jsonBytes = <A>(value: A): number => encoder.encode(jsonKey(value)).length;

/** A page of a list: its entries, the list's length, and the offset of the next page. */
export interface Page<A> {
  readonly entries: ReadonlyArray<A>;
  readonly total: number;
  /** The offset of the next page, or null after the last entry. */
  readonly nextOffset: number | null;
}

/**
 * Returns up to `limit` entries of `list` from `offset`, and stops before the entry whose JSON
 * would take the page past `bytes`.
 */
export const pageOf = <A>(
  list: ReadonlyArray<A>,
  offset: number,
  limit: number,
  bytes: number = PAGE_BYTES,
): Page<A> => {
  const entries: Array<A> = [];
  let used = 2;
  for (const entry of list.slice(offset, offset + limit)) {
    const size = jsonBytes(entry) + 1;
    if (entries.length > 0 && used + size > bytes) break;
    entries.push(entry);
    used += size;
  }
  const end = offset + entries.length;
  return { entries, total: list.length, nextOffset: end < list.length ? end : null };
};

/** The bytes that one code point takes in JSON text, escaped as `JSON.stringify` escapes it. */
const escapedBytes = (codePoint: number) => {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a) return 2;
  if (codePoint === 0x0c || codePoint === 0x0d) return 2;
  if (codePoint < 0x20) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return codePoint < 0x10000 ? 3 : 4;
};

/** Returns the position after the code point at `index` of `text`. */
const nextCodePoint = (text: string, index: number) =>
  index + ((text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);

/**
 * Returns the end of the longest part of `text` from `start` whose escaped JSON fits `bytes`,
 * without splitting a surrogate pair.
 */
const fittingEnd = (text: string, start: number, bytes: number) => {
  let end = start;
  let used = 0;
  while (end < text.length) {
    used += escapedBytes(text.codePointAt(end) ?? 0);
    if (used > bytes) break;
    end = nextCodePoint(text, end);
  }
  return end;
};

/** An entry of a text page: its text, and its view with a part of that text. */
export interface TextEntry<A> {
  readonly text: string;
  /** Returns the entry's view with `part`, the text from position `offset`. */
  readonly view: (part: string, offset: number) => A;
}

/** The views that a text page took from a list of entries, and where the next page starts. */
export interface TextFill<A> {
  readonly views: ReadonlyArray<A>;
  /** The bytes of JSON that the page uses with these views. */
  readonly used: number;
  /** The entry and the position in its text where the next page starts, or null after the last. */
  readonly next: { readonly index: number; readonly offset: number } | null;
}

/**
 * Adds entries to a page that already uses `used` of `bytes`: whole entries while they fit, then
 * the part of the next entry's text that fits. The first entry starts `offset` into its text. A
 * page without an entry yet takes at least one code point, so that reading page after page ends.
 */
export const fillText = <A>(
  entries: ReadonlyArray<TextEntry<A>>,
  offset: number,
  used: number,
  started: boolean,
  bytes: number = PAGE_BYTES,
): TextFill<A> => {
  const views: Array<A> = [];
  let total = used;
  for (const [index, entry] of entries.entries()) {
    const start = index === 0 ? Math.min(offset, entry.text.length) : 0;
    const overhead = jsonBytes(entry.view("", start)) + 1;
    const fitting = fittingEnd(entry.text, start, Math.max(0, bytes - total - overhead));
    const unfinished = start < entry.text.length;
    const full = total + overhead > bytes || (fitting === start && unfinished);
    if (full && (started || views.length > 0))
      return { views, used: total, next: { index, offset: start } };
    const end = fitting === start && unfinished ? nextCodePoint(entry.text, start) : fitting;
    const view = entry.view(entry.text.slice(start, end), start);
    views.push(view);
    total += jsonBytes(view) + 1;
    if (end < entry.text.length) return { views, used: total, next: { index, offset: end } };
  }
  return { views, used: total, next: null };
};

/** Returns the longest start of `text` whose escaped JSON fits `bytes`. */
export const textPrefix = (text: string, bytes: number) =>
  text.slice(0, fittingEnd(text, 0, bytes));

/** Returns at most `length` code units from the start of `text`, without splitting a pair. */
export const textStart = (text: string, length: number) => {
  if (text.length <= length) return text;
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
};
