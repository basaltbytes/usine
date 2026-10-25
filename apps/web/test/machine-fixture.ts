import { RunDetailView, WorkerView } from "@usine/orchestrator/operator";
import { Schema } from "effect";

const machineSchema = RunDetailView.fields.machine;
const pauseSchema = WorkerView.fields.provisioning;
const decodeMachine = Schema.decodeUnknownSync(machineSchema);
const decodePause = Schema.decodeUnknownSync(pauseSchema);

/** Returns a Hetzner machine of `hz-pool` with `fields` replaced. */
export const machineFixture = (
  fields: Partial<NonNullable<(typeof machineSchema)["Encoded"]>> = {},
) => {
  const machine = decodeMachine({
    worker: "hz-pool",
    provider: "hetzner",
    state: "creating",
    id: null,
    runId: "run-queued-398",
    attemptId: null,
    since: "2026-10-20T09:58:00.000Z",
    ...fields,
  });
  if (machine === null) throw new Error("Expected a machine");
  return machine;
};

/** Returns a blocked machine creation pause of `hz-pool` with `fields` replaced. */
export const pauseFixture = (
  fields: Partial<NonNullable<(typeof pauseSchema)["Encoded"]>> = {},
) => {
  const pause = decodePause({
    reason: "capacity",
    message: "Hetzner Cloud has no cx33 servers in nbg1 right now (resource_unavailable)",
    failures: 2,
    failedAt: "2026-10-20T09:55:00.000Z",
    retryAt: "2026-10-20T10:05:00.000Z",
    blocked: true,
    ...fields,
  });
  if (pause === null) throw new Error("Expected a pause");
  return pause;
};
