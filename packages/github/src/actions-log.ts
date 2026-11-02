import { DateTime, Schema } from "effect";

export const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

export const ActionsJob = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      conclusion: Schema.NullOr(Schema.String),
      started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
      completed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  ),
});

const excerpt = (lines: ReadonlyArray<string>, limit: number): string => {
  if (limit <= 0) return "";
  const output = lines.join("\n");
  if (output.length <= limit) return output;
  const tail = lines
    .slice(-8)
    .join("\n")
    .slice(-Math.max(1, Math.floor(limit / 4)));
  let remaining = limit - tail.length - 5;
  if (remaining <= 0) return tail;
  const selected = new Map<number, string>();
  // Runner annotations and test failures take priority over incidental error messages.
  markers: for (const marker of [/##\[error\]|\bFAIL\b|✗/u, /Error:|error TS\d+/u]) {
    for (let index = 0; index < lines.length; index++) {
      if (!marker.test(lines[index] ?? "")) continue;
      for (const nearby of [index, index + 1, index + 2, index + 3, index - 1, index - 2]) {
        const line = lines[nearby];
        if (line === undefined || selected.has(nearby)) continue;
        selected.set(nearby, line.slice(0, remaining));
        remaining -= line.length + 1;
        if (remaining <= 0) break markers;
      }
    }
  }
  const context = [...selected]
    .sort(([left], [right]) => left - right)
    .map(([, line]) => line)
    .join("\n");
  return `${context}\n...\n${tail}`;
};

/** Extracts failed step output from timestamped job logs, including annotation continuations. */
export const failedStepsExcerpt = (job: typeof ActionsJob.Type, log: string): string => {
  const failed = job.steps.filter(
    ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
  );
  if (failed.length === 0) return "";
  const limit = Math.floor(2800 / failed.length);
  const logLines = log.split(/\r?\n/u);
  const sections: Array<string> = [];
  // Second-rounded ranges can overlap; later steps must not reuse consumed lines.
  let nextLine = 0;
  const executed = job.steps.filter(({ conclusion }) => conclusion !== "skipped");
  for (const [stepIndex, step] of executed.entries()) {
    if (step.started_at === null || step.completed_at === null) continue;
    const start = DateTime.toEpochMillis(step.started_at);
    // The step API rounds to seconds; log timestamps retain subsecond precision.
    const end = DateTime.toEpochMillis(step.completed_at) + 1000;
    const next = executed[stepIndex + 1]?.started_at;
    const nextStart = next === undefined || next === null ? end : DateTime.toEpochMillis(next);
    const lines: Array<string> = [];
    let withinStep = false;
    for (const [index, line] of logLines.entries()) {
      if (index < nextLine) continue;
      const timestamp = line.match(/^\uFEFF?(\d{4}-\d\d-\d\dT\S+Z) /u)?.[1];
      if (timestamp !== undefined) {
        const at = Date.parse(timestamp);
        withinStep = at >= start && at < end;
        if (at >= end) break;
      }
      if (!withinStep) continue;
      const content = timestamp === undefined ? line : line.slice(line.indexOf(" ") + 1);
      // Runner headers delimit actions without a shell exit marker, even within one second.
      if (
        lines.length > 0 &&
        timestamp !== undefined &&
        Date.parse(timestamp) >= nextStart &&
        (content.startsWith("##[group]Run ") || content === "Post job cleanup.")
      )
        break;
      if (content === "Post job cleanup." && !step.name.startsWith("Post ")) break;
      lines.push(content);
      nextLine = index + 1;
    }
    if (lines.length > 0 && step.conclusion !== null && FAILED_CONCLUSIONS.has(step.conclusion))
      sections.push(
        `${step.name}\n${excerpt(lines, Math.max(0, limit - step.name.length - 3))}`.slice(
          0,
          Math.max(0, limit - 2),
        ),
      );
  }
  return sections.join("\n\n");
};
