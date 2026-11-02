import { Schema } from "effect";
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

/** Extracts failed step files from an Actions log archive. Invalid ZIP data throws. */
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
    filter: ({ name }) => failed.some(({ number }) => stepNumber(name) === String(number)),
  });
  const sections: Array<string> = [];
  for (const step of failed) {
    const matches = Object.entries(files).filter(
      ([path]) => stepNumber(path) === String(step.number),
    );
    const file = matches[0]?.[1];
    if (matches.length !== 1 || file === undefined || file.byteLength === 0) return "";
    const lines = new TextDecoder()
      .decode(file)
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\S+Z /u, ""));
    sections.push(
      `${step.name}\n${excerpt(lines, Math.max(0, limit - step.name.length - 3))}`.slice(
        0,
        Math.max(0, limit - 2),
      ),
    );
  }
  return sections.join("\n\n");
};
