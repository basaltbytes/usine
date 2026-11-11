import { MutableHashMap, Option } from "effect";
import type { FileChanges, FileRead } from "./model.ts";

/** Returns the UTF-16 size in bytes of the paths and patch text that `changes` holds. */
export const retainedBytes = (changes: FileChanges): number =>
  changes.files.reduce(
    (total, file) =>
      total +
      2 *
        (file.path.length +
          (file.oldPath?.length ?? 0) +
          (file.patch.kind === "text" ? file.patch.text.length : 0)),
    0,
  );

/** The result of retaining one response: kept after `evicted` older entries left, or too large. */
export type Retention =
  | { readonly _tag: "Retained"; readonly bytes: number; readonly evicted: number }
  | { readonly _tag: "Oversized"; readonly bytes: number };

interface Entry {
  readonly changes: FileChanges;
  readonly bytes: number;
}

/**
 * Successful file reads kept within `budget` bytes, as measured by `retainedBytes`. Reading an
 * entry marks it as most recently used, and retaining a new entry evicts the least recently used
 * entries until it fits.
 */
export class RetainedFiles {
  readonly #entries = MutableHashMap.empty<FileRead, Entry>();
  #used = 0;

  readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** The bytes held by all retained entries. */
  get used(): number {
    return this.#used;
  }

  get(read: FileRead): Option.Option<FileChanges> {
    const entry = MutableHashMap.get(this.#entries, read);
    if (Option.isNone(entry)) return Option.none();
    MutableHashMap.remove(this.#entries, read);
    MutableHashMap.set(this.#entries, read, entry.value);
    return Option.some(entry.value.changes);
  }

  retain(read: FileRead, changes: FileChanges): Retention {
    const bytes = retainedBytes(changes);
    this.#forget(read);
    if (bytes > this.budget) return { _tag: "Oversized", bytes };
    const evicted: Array<FileRead> = [];
    let freed = 0;
    for (const [oldest, entry] of this.#entries) {
      if (this.#used - freed + bytes <= this.budget) break;
      evicted.push(oldest);
      freed += entry.bytes;
    }
    for (const oldest of evicted) this.#forget(oldest);
    MutableHashMap.set(this.#entries, read, { changes, bytes });
    this.#used += bytes;
    return { _tag: "Retained", bytes, evicted: evicted.length };
  }

  #forget(read: FileRead): void {
    const entry = MutableHashMap.get(this.#entries, read);
    if (Option.isNone(entry)) return;
    MutableHashMap.remove(this.#entries, read);
    this.#used -= entry.value.bytes;
  }
}
