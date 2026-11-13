// Pi's tool operations are Promise callbacks.
// @effect-diagnostics asyncFunction:off
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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
      // Pi's grep runs ripgrep in this process, so the host's grep replaces it.
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers, at most ${DEFAULT_LIMIT} unless limit says otherwise.`,
      execute: async (_toolCallId, input, signal) => {
        const limit = input.limit ?? DEFAULT_LIMIT;
        const output = await run(
          "grep",
          [
            "-rnI",
            "--exclude-dir=.git",
            "--exclude-dir=node_modules",
            input.literal === true ? "-F" : "-E",
            ...(input.ignoreCase === true ? ["-i"] : []),
            ...(input.glob === undefined ? [] : [`--include=${input.glob}`]),
            ...(input.context === undefined ? [] : [`--context=${input.context}`]),
            "-e",
            input.pattern,
            "--",
            input.path ?? ".",
          ],
          signal,
        );
        // grep exits with 1 when nothing matches.
        if (output.exitCode > 1) throw failed("grep", output);
        const lines = decoder
          .decode(output.stdout)
          .split("\n")
          .filter((line) => line.length > 0);
        const shown = lines.slice(0, limit);
        const text =
          shown.length === 0
            ? "No matches found"
            : shown.join("\n") +
              (lines.length > limit ? `\n\n[${limit} matches shown; more were found]` : "");
        return { content: [{ type: "text", text }], details: undefined };
      },
    }),
  ];
};
