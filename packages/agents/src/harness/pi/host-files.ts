// Pi's tool operations are Promise callbacks.
// @effect-diagnostics asyncFunction:off
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  defineTool,
  formatSize,
  type ToolDefinition,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

/** What a command on the session's host printed, and its exit code. */
export interface PiHostOutput {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs `command` with `args` on the session's host, in the session's working directory. */
export type PiHostCommand = (
  command: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
) => Promise<PiHostOutput>;

/** The most matches or files that one grep or find call returns, as Pi's own tools return. */
const DEFAULT_LIMIT = 100;

const decoder = new TextDecoder();

const failed = (command: string, output: PiHostOutput) =>
  new Error(output.stderr.trim() || `${command} exited with code ${output.exitCode}`);

/** Runs `command` and returns its stdout, or throws with its stderr if it fails. */
const succeeded = async (run: PiHostCommand, command: string, args: ReadonlyArray<string>) => {
  const output = await run(command, args);
  if (output.exitCode !== 0) throw failed(command, output);
  return output.stdout;
};

/** Whether `test` holds for `path` on the host. */
const holds = async (run: PiHostCommand, test: "-e" | "-d" | "-r", path: string) =>
  (await run("test", [test, path])).exitCode === 0;

/**
 * Lists the files under `cwd` that match the glob `pattern`, at most `limit`, skipping version
 * control and dependency directories. Runs with the host's Node.js.
 */
const GLOB_SCRIPT = String.raw`
const fs = require("node:fs");
const [pattern, cwd, limit] = process.argv.slice(1);
const skipped = /(^|\/)(\.git|node_modules)(\/|$)/u;
let listed = 0;
for (const file of fs.globSync(pattern, { cwd, exclude: (path) => skipped.test(path) })) {
  if (listed >= Number(limit)) break;
  process.stdout.write(file + "\n");
  listed += 1;
}
`;

/**
 * Searches the files under a path for a pattern, as Pi's ripgrep search does: a glob with a `/`
 * matches the path relative to the searched directory, and one without matches the file name; the
 * pattern is a regular expression unless it is literal. Skips binary files and version control and
 * dependency directories, stops at the match limit, and truncates each shown line. Prints the
 * result as JSON. Runs with the host's Node.js.
 */
const GREP_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [pattern, target, glob, flags, contextText, limitText, maxLineText] = process.argv.slice(1);
const ignoreCase = flags.includes("i");
const literal = flags.includes("F");
const [context, limit, maxLine] = [contextText, limitText, maxLineText].map(Number);
const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(2);
};
const escape = (text) => text.replace(/[.*+?^\${}()|[\]\\\/]/g, "\\$&");
const source = literal ? escape(pattern) : pattern;
let regex;
try {
  regex = new RegExp(source, ignoreCase ? "iu" : "u");
} catch {
  try {
    regex = new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    fail("Invalid pattern: " + error.message);
  }
}
const globRegex = (text) => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "*" && text[i + 1] === "*") {
      i++;
      if (text[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else if (c === "[") {
      const end = text.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        out += "[" + text.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else out += escape(c);
  }
  return new RegExp("^" + out + "$");
};
const globbed = glob === "" ? undefined : globRegex(glob.replace(/^\.\//, ""));
const included = (relative) =>
  globbed === undefined || globbed.test(glob.includes("/") ? relative : path.basename(relative));
let stat;
try {
  stat = fs.statSync(target);
} catch {
  fail("Path not found: " + target);
}
const lines = [];
let matches = 0;
let limitReached = false;
let truncated = false;
const shown = (text) => {
  if (text.length <= maxLine) return text;
  truncated = true;
  return text.slice(0, maxLine) + "... [truncated]";
};
const search = (file, name) => {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return;
  }
  if (buffer.subarray(0, 8000).includes(0)) return;
  const text = buffer.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < text.length && !limitReached; i++) {
    if (!regex.test(text[i])) continue;
    matches++;
    const end = Math.min(text.length - 1, i + context);
    for (let j = Math.max(0, i - context); j <= end; j++)
      lines.push(name + (j === i ? ":" : "-") + (j + 1) + (j === i ? ": " : "- ") + shown(text[j]));
    if (matches >= limit) limitReached = true;
  }
};
const walk = (directory, relative) => {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (limitReached) return;
    const child = relative === "" ? entry.name : relative + "/" + entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && entry.name !== "node_modules") walk(full, child);
    } else if (entry.isFile() && included(child)) search(full, child);
  }
};
if (stat.isDirectory()) walk(target, "");
else search(target, path.basename(target));
process.stdout.write(JSON.stringify({ lines, matches, limitReached, truncated }));
`;

/** What the grep script prints. */
const GrepResult = Schema.fromJsonString(
  Schema.Struct({
    lines: Schema.Array(Schema.String),
    matches: Schema.Int,
    limitReached: Schema.Boolean,
    truncated: Schema.Boolean,
  }),
);
const decodeGrepResult = Schema.decodePromise(GrepResult);

/** The most characters of a line that grep shows, as Pi's grep shows. */
const GREP_MAX_LINE_LENGTH = 500;

/** A `find -printf` line: the entry type, a space, and the entry name. */
const ENTRY_FORMAT = "%y %f\\0";

/**
 * Pi's read, grep, find, and ls tools, with every file operation run on the session's host
 * through `run`, so that they read only what the host can read. Paths resolve against `cwd` on
 * that host.
 */
export const hostReadTools = (cwd: string, run: PiHostCommand): ReadonlyArray<ToolDefinition> => {
  // ls asks for the type of each entry that it listed; the listing already says.
  const directories = new Map<string, boolean>();
  const read = createReadToolDefinition(cwd, {
    operations: {
      readFile: async (path) => Buffer.from(await succeeded(run, "cat", ["--", path])),
      access: async (path) => {
        if (!(await holds(run, "-r", path))) throw new Error(`ENOENT: no readable file at ${path}`);
      },
    },
  });
  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: (path) => holds(run, "-e", path),
      stat: async (path) => {
        const known = directories.get(path);
        const directory = known ?? (await holds(run, "-d", path));
        if (known === undefined && !directory && !(await holds(run, "-e", path)))
          throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        return { isDirectory: () => directory };
      },
      readdir: async (path) => {
        const listing = decoder.decode(
          await succeeded(run, "find", [
            path,
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-printf",
            ENTRY_FORMAT,
          ]),
        );
        return listing
          .split("\0")
          .filter((entry) => entry.length > 2)
          .map((entry) => {
            const name = entry.slice(2);
            directories.set(`${path.replace(/\/+$/u, "")}/${name}`, entry.startsWith("d "));
            return name;
          });
      },
    },
  });
  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: (path) => holds(run, "-e", path),
      glob: async (pattern, searched, { limit }) =>
        decoder
          .decode(
            await succeeded(run, "node", ["-e", GLOB_SCRIPT, pattern, searched, String(limit)]),
          )
          .split("\n")
          .filter((line) => line.length > 0),
    },
  });
  const grep = createGrepToolDefinition(cwd);
  return [
    defineTool(read),
    defineTool(ls),
    defineTool(find),
    defineTool({
      ...grep,
      // Pi's grep runs ripgrep in this process, so a search with the host's Node.js replaces it.
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
      execute: async (_toolCallId, input, signal) => {
        const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
        const output = await run(
          "node",
          [
            "-e",
            GREP_SCRIPT,
            input.pattern,
            input.path ?? ".",
            input.glob ?? "",
            `-${input.ignoreCase === true ? "i" : ""}${input.literal === true ? "F" : ""}`,
            String(
              input.context !== undefined && input.context > 0 ? Math.floor(input.context) : 0,
            ),
            String(Math.floor(limit)),
            String(GREP_MAX_LINE_LENGTH),
          ],
          signal,
        );
        if (output.exitCode !== 0) throw failed("grep", output);
        const result = await decodeGrepResult(decoder.decode(output.stdout));
        if (result.matches === 0)
          return { content: [{ type: "text", text: "No matches found" }], details: undefined };
        const truncation = truncateHead(result.lines.join("\n"), {
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        const notices = [
          ...(result.limitReached
            ? [`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`]
            : []),
          ...(truncation.truncated ? [`${formatSize(DEFAULT_MAX_BYTES)} limit reached`] : []),
          ...(result.truncated
            ? [
                `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
              ]
            : []),
        ];
        const text =
          notices.length === 0
            ? truncation.content
            : `${truncation.content}\n\n[${notices.join(". ")}]`;
        return { content: [{ type: "text", text }], details: undefined };
      },
    }),
  ];
};
