import { ContainerLimits, WorkerName } from "@usine/core/worker";
import { type Brand, Option, Schema } from "effect";
import type { WorkerPreflight } from "../worker-status.ts";
import { checkView, HarnessPreflightView, PreflightCheckView } from "./configuration/view.ts";

/** The stored checks returned by an on-demand worker preflight. */
export class WorkerPreflightView extends Schema.Class<
  WorkerPreflightView,
  Brand.Brand<"@usine/orchestrator/operator/preflight/WorkerPreflightView">
>("@usine/orchestrator/WorkerPreflightView")({
  worker: WorkerName,
  prerequisites: Schema.NullOr(PreflightCheckView),
  harnesses: Schema.Array(HarnessPreflightView),
  containerLimits: Schema.NullOr(ContainerLimits),
}) {}

export const workerPreflightView = (preflight: WorkerPreflight): WorkerPreflightView =>
  WorkerPreflightView.make({
    worker: preflight.worker,
    prerequisites: Option.getOrNull(Option.map(preflight.prerequisites, checkView)),
    harnesses: preflight.harnesses.map(({ harness, check }) =>
      HarnessPreflightView.make({ harness, check: checkView(check) }),
    ),
    containerLimits: Option.getOrNull(preflight.containerLimits),
  });
