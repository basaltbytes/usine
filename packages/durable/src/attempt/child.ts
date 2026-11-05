import { ChildRequest } from "@usine/agents/runtime";
import { defineDoc } from "@earendil-works/pi-durable";
import { ChildSession, HarnessSession } from "@usine/core/agent/session";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Brand, Schema } from "effect";

/** The saved conversation and worker that belong to one durable delegation. */
export class SavedChild extends Schema.Class<
  SavedChild,
  Brand.Brand<"@usine/durable/attempt/SavedChild">
>("@usine/durable/SavedChild")({
  session: ChildSession,
  usage: ChildRequest.fields.usage,
  harnessSession: HarnessSession,
  worker: WorkerName,
  machine: Schema.OptionFromNullOr(MachineId),
}) {}

type SubagentRecord = {
  count: number | null;
  saved: typeof SavedChild.Encoded | null;
  output: string;
  /** Absent on older delegations; the child had no committed idle report. */
  idle?: string | null;
};

export const SubagentDoc = defineDoc<SubagentRecord>({
  kind: "usine.subagent",
  version: 1,
  scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ count: null, saved: null, output: "", idle: null }),
});
