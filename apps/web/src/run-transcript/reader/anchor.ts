import type { TranscriptSequence } from "@usine/engine/transcript";
import { Option } from "effect";
import type { ReaderDocument } from "../document/model.ts";
import type { TranscriptTool } from "../model.ts";
import type { ReadingAnchor } from "./memory.ts";

/** One possible reading surface, including its disclosure path and durable burst members. */
export interface ReadingRow {
  readonly key: string;
  readonly surface: ReadingAnchor["surface"];
  readonly sequence: TranscriptSequence;
  readonly elementId: string;
  readonly messageId: string;
  readonly openKeys: ReadonlyArray<string>;
  readonly groupKeys: ReadonlyArray<string>;
}

const toolRows = (
  tool: TranscriptTool,
  groupKeys: ReadonlyArray<string>,
): ReadonlyArray<ReadingRow> => {
  const row: ReadingRow = {
    key: tool.key,
    sequence: tool.sequence,
    surface: "row",
    elementId: tool.key,
    messageId: tool.key,
    openKeys: [],
    groupKeys,
  };
  return [row, { ...row, surface: "result", elementId: `${tool.key}:result`, openKeys: [tool.key] }];
};

const plainRow = (key: string, sequence: TranscriptSequence): ReadingRow => ({
  key,
  sequence,
  surface: "row",
  elementId: key,
  messageId: key,
  openKeys: [],
  groupKeys: [],
});

/** Indexes rendered identities without retaining any of their contents in a bookmark. */
export const readingRows = (document: ReaderDocument): ReadonlyArray<ReadingRow> =>
  document.chapters.flatMap((chapter) =>
    chapter.rows.flatMap((row): ReadonlyArray<ReadingRow> => {
      switch (row._tag) {
        case "Message":
        case "Note":
          return [plainRow(row.key, row.sequence)];
        case "Ending":
          return Option.match(row.position, {
            onNone: () => [],
            onSome: ({ key, sequence }) => [plainRow(key, sequence)],
          });
        case "Delegation":
          return toolRows(row.tool, []);
        case "Burst": {
          const keys = row.tools.map((tool) => tool.key);
          return [
            {
              key: row.tools[0].key,
              sequence: row.tools[0].sequence,
              surface: "group",
              elementId: row.key,
              messageId: row.key,
              openKeys: [],
              groupKeys: keys,
            },
            ...row.tools.flatMap((tool) => toolRows(tool, keys)),
          ];
        }
      }
    }),
  );

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
 * Prefers the same durable member even when its burst gains an earlier first call.
 * Waits for history until the matching row reaches its saved sequence.
 * Exhausted history falls back to the nearest surviving row.
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
  // A result can arrive before its earlier input page while retaining the same tool identity.
  if (exact !== undefined && exact.sequence <= anchor.sequence)
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
