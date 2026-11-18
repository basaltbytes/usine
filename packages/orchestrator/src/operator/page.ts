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
