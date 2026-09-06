import {
  sessionActivityLabel,
  type TranscriptEntry,
  type TranscriptProjection,
  type TranscriptSession,
  type TranscriptTool,
} from "../model.ts";
export { groupSummary } from "./summary.ts";

type CompletedTool = TranscriptTool & { readonly state: { readonly _tag: "Finished" } };

/** Adjacent completed calls from one session, with each original tool identity intact. */
export interface ToolGroup {
  readonly _tag: "ToolGroup";
  readonly key: string;
  readonly tools: readonly [CompletedTool, CompletedTool, ...CompletedTool[]];
}

/** A child session's conversation after routine calls have been grouped. */
export type GroupedSession = Omit<TranscriptSession, "entries"> & {
  readonly activity: string;
  readonly entries: ReadonlyArray<TranscriptEntry | ToolGroup>;
};

/** Conversation rows, preserving notices, live calls and child-session boundaries. */
export type GroupedItem = TranscriptEntry | GroupedSession | ToolGroup;

const completedTool = (item: TranscriptEntry | TranscriptSession): item is CompletedTool =>
  item._tag === "Tool" && item.state._tag === "Finished";

const groupEntries = <T extends TranscriptEntry | TranscriptSession>(
  items: ReadonlyArray<T>,
  owners: ReadonlyMap<string, string>,
): ReadonlyArray<T | ToolGroup> => {
  const grouped: Array<T | ToolGroup> = [];
  let pending: Array<T & CompletedTool> = [];
  let owner: string | undefined;
  const flush = () => {
    const [first, second, ...rest] = pending;
    if (first !== undefined && second !== undefined)
      grouped.push({
        _tag: "ToolGroup",
        key: `tool-group:${first.key}`,
        tools: [first, second, ...rest],
      });
    else if (first !== undefined) grouped.push(first);
    pending = [];
  };
  for (const item of items) {
    const nextOwner = owners.get(item.key);
    if (!completedTool(item) || nextOwner === undefined) {
      flush();
      grouped.push(item);
      owner = undefined;
      continue;
    }
    if (owner !== nextOwner) flush();
    owner = nextOwner;
    pending.push(item);
  }
  flush();
  return grouped;
};

/** Groups before filtering, so hidden prose never joins calls across a message boundary. */
export const groupTranscript = (projection: TranscriptProjection): ReadonlyArray<GroupedItem> => {
  const owners = new Map(
    projection.sessions.flatMap((session) =>
      session.entries.map((entry) => [entry.key, session.key] as const),
    ),
  );
  return groupEntries(projection.items, owners).map((item) =>
    item._tag === "Session"
      ? {
          ...item,
          activity: sessionActivityLabel(item),
          entries: groupEntries(item.entries, owners),
        }
      : item,
  );
};
