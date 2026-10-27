import type { TranscriptSequence } from "@usine/engine/transcript";
import { Option } from "effect";
import type { ReaderDocument } from "~/lib/runs/transcript/document/model";
import type { TranscriptTool } from "~/lib/runs/transcript/model";
import type { ReadingAnchor } from "~/lib/runs/transcript/reader/memory";

/** A scroll target in the reader, with the disclosure keys to open and its burst's member keys. */
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
  return [
    row,
    { ...row, surface: "result", elementId: `${tool.key}:result`, openKeys: [tool.key] },
  ];
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

/** Returns every scroll target in `document` as keys and sequences, without content. */
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
        case "GitHubChange":
        case "BoardMove":
          return [];
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
 * Returns the row matching `anchor`, including inside a burst that gained an earlier call. If no
 * matching row is loaded, returns `Earlier` while history is available, else the nearest row.
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
  // A tool result can load before the page with its input, and keeps the same tool key.
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
