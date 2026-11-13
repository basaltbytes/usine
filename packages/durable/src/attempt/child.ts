import { defineDoc } from "@earendil-works/pi-durable";
import type { SavedChild } from "./delegation/journal.ts";

type SubagentRecord = {
  count: number | null;
  saved: typeof SavedChild.Encoded | null;
  output: string;
  /** Absent on older delegations; the child had no committed idle report. */
  idle?: string | null;
  /** Absent on older delegations; their idle report didn't answer the operator. */
  idleAnsweredOperator?: boolean;
  continuations?: Array<number>;
  /** Absent on older delegations, which recorded no native user-message items. */
  receipts?: Array<string>;
  inFlight?: Array<{ callId: string; tool: string }>;
  /** Absent on older delegations, which saved the conversation only after the prompt. */
  prompted?: boolean;
};

/** The progress of one `subagent` call's delegation, keyed by the call's task. */
export const SubagentDoc = defineDoc<SubagentRecord>({
  kind: "usine.subagent",
  version: 1,
  scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ count: null, saved: null, output: "", idle: null }),
});
