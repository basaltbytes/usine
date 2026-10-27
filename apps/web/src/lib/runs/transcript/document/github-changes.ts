import type { AttemptId } from "@usine/core/attempt";
import type { GitHubChangeView, LabelView } from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import type { TranscriptTool } from "~/lib/runs/transcript/model";
import {
  terminalText,
  type BoardMoveRow,
  type Chapter,
  type ChapterRow,
  type GitHubChangeRow,
  type LabelChanges,
  type ReaderDocument,
} from "~/lib/runs/transcript/document/model";

// GitHub records the label removals and additions of one command in the same second; a swap done
// with two commands is a few seconds apart.
const LABELS_IN_ONE_GO_MILLIS = 10_000;

const toolStart = (tool: TranscriptTool): number =>
  Date.parse(
    Option.match(tool.start, {
      onNone: () => tool.receivedAt,
      onSome: ({ receivedAt }) => receivedAt,
    }),
  );

// Returns the start time of a row; the outcome sorts after every change of its Attempt.
const rowStart = (row: ChapterRow): number =>
  Match.valueTags(row, {
    Message: ({ receivedAt }) => Date.parse(receivedAt),
    Note: ({ receivedAt }) => Date.parse(receivedAt),
    Burst: ({ tools }) => toolStart(tools[0]),
    Delegation: ({ tool }) => toolStart(tool),
    Ending: () => Number.POSITIVE_INFINITY,
    GitHubChange: ({ at }) => Date.parse(at),
    BoardMove: ({ move }) => Date.parse(move.at),
  });

// Returns whether the outcome links to the comment or review, matched by its URL anchor.
const linkedBy = (outcome: string | null, url: string): boolean => {
  if (outcome === null) return false;
  const anchor = url.split("#")[1];
  return outcome.includes(anchor === undefined || anchor === "" ? url : anchor);
};

// Returns whether the outcome states the label change, for example "removed `agent-in-progress`".
const statedBy = (outcome: string | null, verb: "added" | "removed", label: LabelView) =>
  outcome !== null &&
  new RegExp(
    `\\b${verb} ${label.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`,
    "iu",
  ).test(outcome.replaceAll("`", ""));

const unstated = (outcome: string | null) => (row: GitHubChangeRow) => {
  if (row.change._tag !== "Labels") return linkedBy(outcome, row.change.url) ? [] : [row];
  const removed = row.change.removed.filter((label) => !statedBy(outcome, "removed", label));
  const added = row.change.added.filter((label) => !statedBy(outcome, "added", label));
  return removed.length + added.length === 0
    ? []
    : [{ ...row, change: { ...row.change, removed, added } }];
};

interface Placed {
  /** The index of the first row that started after the change, or the row count if none did. */
  readonly slot: number;
  readonly row: GitHubChangeRow | BoardMoveRow;
}

// Puts consecutive label changes between two rows within `LABELS_IN_ONE_GO_MILLIS` in one row.
const changeRows = (
  attemptId: AttemptId,
  changes: ReadonlyArray<GitHubChangeView>,
  slotOf: (at: string) => number,
): ReadonlyArray<Placed> => {
  const placed: Array<Placed> = [];
  for (const change of changes) {
    const slot = slotOf(change.at);
    if (change._tag === "BoardMoved") {
      placed.push({
        slot,
        row: { _tag: "BoardMove", key: `board-move:${attemptId}:${change.at}`, move: change },
      });
      continue;
    }
    if (change._tag === "Commented" || change._tag === "Reviewed") {
      placed.push({
        slot,
        row: { _tag: "GitHubChange", key: `github:${change.url}`, at: change.at, change },
      });
      continue;
    }
    const last = placed.at(-1);
    const joining =
      last !== undefined &&
      last.slot === slot &&
      last.row._tag === "GitHubChange" &&
      last.row.change._tag === "Labels" &&
      Date.parse(change.at) - Date.parse(last.row.at) <= LABELS_IN_ONE_GO_MILLIS
        ? { row: last.row, change: last.row.change }
        : undefined;
    const labels: LabelChanges = joining?.change ?? { _tag: "Labels", removed: [], added: [] };
    const next: LabelChanges =
      change._tag === "LabelAdded"
        ? { ...labels, added: [...labels.added, change.label] }
        : { ...labels, removed: [...labels.removed, change.label] };
    if (joining !== undefined)
      placed[placed.length - 1] = { slot, row: { ...joining.row, change: next } };
    else
      placed.push({
        slot,
        row: {
          _tag: "GitHubChange",
          key: `github:${attemptId}:${change.at}`,
          at: change.at,
          change: next,
        },
      });
  }
  return placed;
};

const placeInChapter = (
  chapter: Chapter,
  changes: ReadonlyArray<GitHubChangeView>,
  earlierUnloaded: boolean,
): Chapter => {
  const ending = chapter.rows.find((row) => row._tag === "Ending");
  const outcome = ending?._tag === "Ending" ? terminalText(ending.end) : null;
  const first = chapter.rows[0];
  // If earlier activity is not loaded, changes before the first loaded row are skipped.
  const loadedFrom = !earlierUnloaded
    ? Number.NEGATIVE_INFINITY
    : first === undefined
      ? Number.POSITIVE_INFINITY
      : rowStart(first);
  const slotOf = (at: string) => {
    const found = chapter.rows.findIndex((row) => rowStart(row) > Date.parse(at));
    return found === -1 ? chapter.rows.length : found;
  };
  const lines = changeRows(chapter.attemptId, changes, slotOf).flatMap(({ slot, row }) =>
    rowStart(row) < loadedFrom
      ? []
      : (row._tag === "BoardMove" ? [row] : unstated(outcome)(row)).map((kept) => ({
          slot,
          kept,
        })),
  );
  if (lines.length === 0) return chapter;
  const placed = (slot: number) => lines.flatMap((line) => (line.slot === slot ? [line.kept] : []));
  return {
    ...chapter,
    rows: [
      ...chapter.rows.flatMap((row, slot): ReadonlyArray<ChapterRow> => [...placed(slot), row]),
      ...placed(chapter.rows.length),
    ],
  };
};

/**
 * Inserts each Attempt's GitHub changes before the first row that started after the change. Changes
 * that the outcome links to or states are shown only in the outcome.
 */
export const withGitHubChanges = (
  document: ReaderDocument,
  changes: ReadonlyMap<AttemptId, ReadonlyArray<GitHubChangeView>>,
  earlierUnloaded: ReadonlySet<AttemptId>,
): ReaderDocument => ({
  chapters: document.chapters.map((chapter) =>
    placeInChapter(
      chapter,
      changes.get(chapter.attemptId) ?? [],
      earlierUnloaded.has(chapter.attemptId),
    ),
  ),
});
