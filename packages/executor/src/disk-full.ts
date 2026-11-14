import type { WorkerName } from "@usine/core/worker";
import { Effect, Predicate } from "effect";
import { type ExecutorError, WorkerCapabilityError } from "./executor.ts";

/** What Node, Git, Docker, and Podman print when a write fails because the disk is full. */
const DISK_FULL = /ENOSPC|no space left on device/iu;

/** Returns whether `error`, or a cause it wraps, reports that the disk is full. */
export const reportsDiskFull = (error: ExecutorError): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (Predicate.isObject(current) && !seen.has(current)) {
    seen.add(current);
    if (
      "message" in current &&
      Predicate.isString(current.message) &&
      DISK_FULL.test(current.message)
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return Predicate.isString(current) && DISK_FULL.test(current);
};

const isDiskFull = (error: ExecutorError): boolean =>
  !(error._tag === "WorkerCapabilityError" && error.capability === "disk") &&
  reportsDiskFull(error);

/**
 * Returns `effect` with a failure of one of the executor's own commands that ran out of disk
 * space on `worker` replaced by a `disk` capability error, so the Worker waits for a preflight
 * that passes instead of the Attempt failing as if its task were blocked.
 */
export const classifyDiskFull = <A, R>(
  worker: WorkerName,
  effect: Effect.Effect<A, ExecutorError, R>,
): Effect.Effect<A, ExecutorError, R> =>
  Effect.catchIf(effect, isDiskFull, (error) =>
    Effect.logWarning("A worker command ran out of disk space; the worker needs a preflight", {
      worker,
      error: error._tag,
      message: error.message,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          WorkerCapabilityError.make({
            worker,
            capability: "disk",
            message: `Worker "${worker}" ran out of disk space: ${error.message}`,
            cause: error,
          }),
        ),
      ),
    ),
  );
