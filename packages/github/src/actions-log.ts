import { DateTime, Schema } from "effect";
import { unzipSync } from "fflate/browser";

export const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ActionsJob = Schema.Struct({
  name: Schema.NonEmptyString,
  run_id: PositiveInt,
  run_attempt: PositiveInt,
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      conclusion: Schema.NullOr(Schema.String),
      number: PositiveInt,
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

const decodeLines = (file: Uint8Array) =>
  new TextDecoder()
    .decode(file)
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u);
const stripTimestamp = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT\S+Z /u, "");

const combinedStepLogs = (job: typeof ActionsJob.Type, file: Uint8Array) => {
  let second = "";
  const lines = decodeLines(file).map((line) => {
    second = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\S*Z /u)?.[1] ?? second;
    return { second, text: stripTimestamp(line) };
  });
  const steps = job.steps.flatMap((step) =>
    step.conclusion === "skipped" || step.started_at === null || step.completed_at === null
      ? []
      : [
          {
            number: step.number,
            name: step.name,
            startSecond: DateTime.formatIso(step.started_at).slice(0, 19),
            endSecond: DateTime.formatIso(step.completed_at).slice(0, 19),
          },
        ],
  );
  const candidates = steps.flatMap((step, index) => {
    const postJob = step.name.startsWith("Post ") || step.name === "Complete job";
    const header = step.name.startsWith("Post ")
      ? "Post job cleanup."
      : step.name === "Complete job"
        ? "Cleaning up orphan processes"
        : `##[group]${step.name.split("\n")[0]}`;
    let positions = lines.flatMap((line, index) =>
      line.second === step.startSecond && line.text === header ? [index] : [],
    );
    const previous = steps[index - 1];
    if (
      positions.length === 0 &&
      (previous === undefined || previous.endSecond < step.startSecond)
    ) {
      const start = lines.findIndex((line) => line.second >= step.startSecond);
      if (start !== -1) positions = [start];
    }
    const matched = positions.length > 0;
    if (!matched && !postJob)
      positions = lines.flatMap((line, index) =>
        line.second === step.startSecond && line.text.startsWith("##[group]Run ") ? [index] : [],
      );
    return positions.length === 0 ? [] : [{ number: step.number, positions, matched }];
  });
  const align = (choices: typeof candidates, reverse: boolean) => {
    const aligned = new Map<number, number>();
    let boundary = reverse ? lines.length : -1;
    for (const candidate of reverse ? [...choices].reverse() : choices) {
      const position = reverse
        ? [...candidate.positions].reverse().find((line) => line < boundary)
        : candidate.positions.find((line) => line > boundary);
      if (position === undefined) return new Map<number, number>();
      aligned.set(candidate.number, position);
      boundary = position;
    }
    return aligned;
  };
  // Match headers backwards so repeated commands inside composite actions remain in their step.
  const latest = align(candidates, true);
  const anchored = candidates.map((candidate) => {
    const position = latest.get(candidate.number);
    return candidate.matched && position !== undefined
      ? { ...candidate, positions: [position] }
      : candidate;
  });
  const earliest = align(anchored, false);
  const starts = new Map<number, number>();
  // Custom display names require the same boundary in every ordered alignment.
  for (const [number, position] of earliest) {
    if (position === latest.get(number)) starts.set(number, position);
  }
  const logs = new Map<number, ReadonlyArray<string>>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step === undefined) continue;
    const start = starts.get(step.number);
    const next = steps[index + 1];
    const end = next === undefined ? lines.length : starts.get(next.number);
    if (start === undefined || end === undefined) continue;
    logs.set(
      step.number,
      lines
        .slice(start, end)
        .filter((line) => line.second <= step.endSecond)
        .map((line) => line.text),
    );
  }
  return logs;
};

/** Extracts failed steps from numbered files or a combined job log. Invalid ZIP data throws. */
export const failedStepsExcerpt = (job: typeof ActionsJob.Type, archive: Uint8Array): string => {
  const failed = job.steps.filter(
    ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
  );
  if (failed.length === 0) return "";
  const limit = Math.floor(2800 / failed.length);
  // GitHub removes slashes and colons and truncates job folders to 90 UTF-16 units.
  const folder = job.name
    .replace(/[/:]/gu, "")
    .slice(0, 90)
    .replace(/[\uD800-\uDBFF]$/u, "");
  const stepNumber = (path: string) => {
    const [directory, file, extra] = path.split("/");
    if (directory !== folder || file === undefined || extra !== undefined) return undefined;
    return file.match(/^(\d+)_.*\.txt$/u)?.[1];
  };
  const files = unzipSync(archive, {
    filter: ({ name }) =>
      failed.some(({ number }) => stepNumber(name) === String(number)) ||
      (/^\d+_/u.test(name) && name.replace(/^\d+_/u, "") === `${folder}.txt`),
  });
  const combined = Object.entries(files).filter(([path]) => !path.includes("/"));
  const combinedFile = combined.length === 1 ? combined[0]?.[1] : undefined;
  const fallback =
    combinedFile === undefined
      ? new Map<number, ReadonlyArray<string>>()
      : combinedStepLogs(job, combinedFile);
  const sections: Array<string> = [];
  for (const step of failed) {
    const matches = Object.entries(files).filter(
      ([path]) => stepNumber(path) === String(step.number),
    );
    const file = matches[0]?.[1];
    const lines =
      matches.length === 1 && file !== undefined && file.byteLength > 0
        ? decodeLines(file).map(stripTimestamp)
        : fallback.get(step.number);
    if (lines === undefined || lines.length === 0) return "";
    sections.push(
      `${step.name}\n${excerpt(lines, Math.max(0, limit - step.name.length - 3))}`.slice(
        0,
        Math.max(0, limit - 2),
      ),
    );
  }
  return sections.join("\n\n");
};
