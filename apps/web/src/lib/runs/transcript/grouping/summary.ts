import type { Burst } from "~/lib/runs/transcript/document/model";
import { presentTool, type ToolActivity } from "~/lib/runs/transcript/tool/presentation";

// Returns `tests` or `build` only for known complete invocations; other arguments, shell
// composition, and wrappers return `command`.
const commandPurpose = (command: string | undefined): "tests" | "build" | "command" => {
  const invocation = command?.trim().replace(/[ \t]+/gu, " ") ?? "";
  const script =
    /^(?:npm|yarn|bun|pnpm(?: --filter (?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)?)(?: run)? (test|build)$/u.exec(
      invocation,
    )?.[1];
  if (
    script === "test" ||
    /^(?:vitest run|pytest|python3? -m pytest|cargo test|go test(?: \.\/\.\.\.)?|node --test)$/u.test(
      invocation,
    )
  )
    return "tests";
  return script === "build" ? "build" : "command";
};

const activityKey = (activity: ToolActivity): string => {
  switch (activity._tag) {
    case "Files":
      return activity.operation;
    case "Command":
      return commandPurpose(activity.command);
    default:
      return activity._tag;
  }
};

// A file name in a summary is the shortest path suffix that is unique among all recorded paths. If
// it does not fit in `FILE_SUBJECT_LIMIT` characters, the summary shows a file count instead.
const FILE_SUBJECT_LIMIT = 56;
const compactPath = (path: string, paths: ReadonlyArray<string>): string | undefined => {
  // The extra character detects a directory name cut off at the start of the window.
  const parts = path.slice(-(FILE_SUBJECT_LIMIT + 1)).split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const suffix = parts.slice(-depth).join("/");
    if (
      paths.every((other) => other === path || (other !== suffix && !other.endsWith(`/${suffix}`)))
    )
      return suffix;
  }
  return path.length <= FILE_SUBJECT_LIMIT ? path : undefined;
};

const fileSummary = (
  activity: Extract<ToolActivity, { readonly _tag: "Files" }>,
  calls: ReadonlyArray<ToolActivity>,
  allPaths: ReadonlyArray<string>,
): string => {
  const paths = [...new Set(calls.flatMap((call) => (call._tag === "Files" ? call.paths : [])))];
  const verb = { read: "read", edit: "edited", write: "wrote", change: "changed" }[
    activity.operation
  ];
  if (
    calls.some(
      (call) =>
        call._tag === "Files" &&
        (call.paths.length === 0 || call.paths.some((path) => path.trim() === "")),
    )
  ) {
    const noun = activity.operation;
    return `${calls.length} file ${noun}${calls.length === 1 ? "" : "s"}`;
  }
  const counted = `${verb} ${paths.length} ${paths.length === 1 ? "file" : "files"}`;
  if (paths.length > 2) return counted;
  const names: Array<string> = [];
  for (const path of paths) {
    const name = compactPath(path, allPaths);
    if (name === undefined) return counted;
    names.push(name);
  }
  const subject = names.join(", ");
  // File names come from untrusted payloads, so only short names with safe characters are shown.
  const readable = names.every(
    (name) => name.trim() !== "" && !/[^\p{L}\p{N} ._@()+/-]/u.test(name),
  );
  return subject.length <= FILE_SUBJECT_LIMIT && readable ? `${verb} ${subject}` : counted;
};

const activitySummary = (
  first: ToolActivity,
  calls: ReadonlyArray<ToolActivity>,
  paths: ReadonlyArray<string>,
): string => {
  const count = calls.length;
  const plural = count === 1 ? "" : "s";
  switch (first._tag) {
    case "Files":
      return fileSummary(first, calls, paths);
    case "Command": {
      const purpose = commandPurpose(first.command);
      if (purpose === "tests") return `ran tests${count === 1 ? "" : ` ${count} times`}`;
      if (purpose === "build") return `ran ${count === 1 ? "a build" : `${count} builds`}`;
      return `ran ${count} command${plural}`;
    }
    case "Search":
      return count === 1 ? "searched" : `searched ${count} times`;
    case "Delegation":
      return `delegated ${count} task${plural}`;
    case "Tool":
      return `${count} tool call${plural}`;
  }
};

/** Returns at most two descriptions in first-seen order, followed by the count of remaining calls. */
export const burstSummary = (burst: Pick<Burst, "tools">): string => {
  const activities = burst.tools.map((tool) => presentTool(tool).activity);
  const paths = [
    ...new Set(activities.flatMap((activity) => (activity._tag === "Files" ? activity.paths : []))),
  ];
  const buckets = new Map<string, [ToolActivity, ...ToolActivity[]]>();
  for (const activity of activities) {
    const key = activityKey(activity);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [activity]);
    else bucket.push(activity);
  }
  const ordered = [...buckets.values()];
  const summaries = ordered.slice(0, 2).map((calls) => activitySummary(calls[0], calls, paths));
  const remaining = ordered.slice(2).reduce((count, bucket) => count + bucket.length, 0);
  if (remaining > 0) summaries.push(`${remaining} more ${remaining === 1 ? "call" : "calls"}`);
  const summary = summaries.join(" · ");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
};
