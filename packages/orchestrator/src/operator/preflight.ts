import { ContainerLimits, WorkerName } from "@usine/core/worker";
import { Option, Schema } from "effect";
import type { WorkerPreflight } from "../worker-status.ts";
import { checkView, HarnessPreflightView, PreflightCheckView } from "./configuration/view.ts";

/** The stored checks returned by an on-demand worker preflight. */
export class WorkerPreflightView extends Schema.Class<WorkerPreflightView>(
  "@usine/orchestrator/WorkerPreflightView",
)({
  worker: WorkerName,
  prerequisites: Schema.NullOr(PreflightCheckView),
  harnesses: Schema.Array(HarnessPreflightView),
  containerLimits: Schema.NullOr(ContainerLimits),
}) {}

export const workerPreflightView = (preflight: WorkerPreflight): WorkerPreflightView =>
  new WorkerPreflightView({
    worker: preflight.worker,
    prerequisites: Option.getOrNull(Option.map(preflight.prerequisites, checkView)),
    harnesses: preflight.harnesses.map(
      ({ harness, check }) => new HarnessPreflightView({ harness, check: checkView(check) }),
    ),
    containerLimits: Option.getOrNull(preflight.containerLimits),
  });
