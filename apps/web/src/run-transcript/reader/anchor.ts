import type { TranscriptSequence } from "@usine/engine/transcript";
import { groupTranscript, type GroupedItem } from "../grouping/model.ts";
import { matchesFilter, type TranscriptFilter, type TranscriptProjection } from "../model.ts";
import type { ReadingAnchor } from "./memory.ts";

/** One possible reading surface, including its disclosure path and durable group members. */
export interface ReadingRow {
  readonly key: string;
  readonly surface: ReadingAnchor["surface"];
  readonly sequence: TranscriptSequence;
  readonly elementId: string;
  readonly messageId: string;
  readonly openKeys: ReadonlyArray<string>;
  readonly groupKeys: ReadonlyArray<string>;
}

/** Indexes rendered identities without retaining any of their contents in a bookmark. */
export const readingRows = (
  projection: TranscriptProjection,
  filter: TranscriptFilter,
): ReadonlyArray<ReadingRow> => {
  const rows: Array<ReadingRow> = [];
  const append = (
    item: GroupedItem,
    openKeys: ReadonlyArray<string>,
    groupKeys: ReadonlyArray<string>,
  ) => {
    if (item._tag === "ToolGroup") {
      if (filter === "messages") return;
      const keys = item.tools.map((tool) => tool.key);
      rows.push({
        key: item.tools[0].key,
        sequence: item.tools[0].sequence,
        surface: "group",
        elementId: item.key,
        messageId: item.key,
        openKeys,
        groupKeys: keys,
      });
      for (const tool of item.tools) append(tool, openKeys, keys);
      return;
    }
    if (item._tag !== "Session" && !matchesFilter(item, filter)) return;
    const row: ReadingRow = {
      key: item.key,
      sequence: item.sequence,
      surface: "row",
      elementId: item.key,
      messageId: item.key,
      openKeys,
      groupKeys,
    };
    rows.push(row);
    if (item._tag === "Session")
      for (const entry of item.entries) append(entry, [...openKeys, item.key], []);
    if (item._tag === "Tool")
      rows.push({
        ...row,
        surface: "result",
        elementId: `${item.key}:result`,
        openKeys: [...openKeys, item.key],
      });
  };
  for (const item of groupTranscript(projection)) append(item, [], []);
  return rows;
};

type Restoration =
  | { readonly _tag: "Earlier" }
  | { readonly _tag: "Empty" }
  | {
      readonly _tag: "Row";
      readonly row: ReadingRow;
      readonly offset: number;
      readonly fallback: boolean;
    };

/**
 * Prefers the same durable member even when its group gains an earlier first call.
 * Missing rows wait for history; once exhausted, use the nearest surviving row.
 */
export const locateReadingAnchor = (
  anchor: ReadingAnchor,
  rows: ReadonlyArray<ReadingRow>,
  history: "available" | "exhausted",
): Restoration => {
  const exact = rows.find(
    (row) =>
      row.surface === anchor.surface &&
      (row.key === anchor.key || (row.surface === "group" && row.groupKeys.includes(anchor.key))),
  );
  if (exact !== undefined)
    return { _tag: "Row", row: exact, offset: anchor.offset, fallback: false };
  if (history === "available") return { _tag: "Earlier" };
  const surviving = rows.find((row) => row.key === anchor.key && row.surface === "row");
  const nearest =
    surviving ??
    rows
      .filter((row) => row.surface !== "result")
      .reduce<ReadingRow | undefined>(
        (best, row) =>
          best === undefined ||
          Math.abs(row.sequence - anchor.sequence) < Math.abs(best.sequence - anchor.sequence)
            ? row
            : best,
        undefined,
      );
  return nearest === undefined
    ? { _tag: "Empty" }
    : { _tag: "Row", row: nearest, offset: 0, fallback: true };
};
