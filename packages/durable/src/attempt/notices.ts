import type * as AttemptChannel from "@usine/core/attempt/channel";

/**
 * Returns the notices to buffer after `notice`: the latest one, preceded by the last
 * `WorkerUnresponsive` if the latest is a `WorkerResponsive`.
 */
export const keepNotice = (
  kept: ReadonlyArray<AttemptChannel.WorkerNotice>,
  notice: AttemptChannel.WorkerNotice,
): ReadonlyArray<AttemptChannel.WorkerNotice> => {
  const previous = kept.at(-1);
  return notice._tag === "WorkerResponsive" && previous?._tag === "WorkerUnresponsive"
    ? [previous, notice]
    : [notice];
};
