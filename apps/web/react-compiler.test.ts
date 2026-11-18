import { parseSync, transformFromAstSync, traverse } from "@babel/core";
import compiler, { type LoggerEvent, type ErrorCategory } from "babel-plugin-react-compiler";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilerOptions } from "./react-compiler";

const sourceRoot = new URL("./src/", import.meta.url);
const sources = await Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* fs.readDirectory(fileURLToPath(sourceRoot), { recursive: true });
  return yield* Effect.forEach(
    files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && !file.endsWith(".d.ts")).sort(),
    (file) =>
      fs
        .readFileString(fileURLToPath(new URL(file, sourceRoot)))
        .pipe(Effect.map((source) => ({ file, source }))),
  );
}).pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise);

type CompilationFailure = {
  readonly component: string;
  readonly category: ErrorCategory | "CompileSkip" | "PipelineError";
  readonly reason: string;
  readonly message: string;
};

// TanStack Virtual returns mutable controller methods that memoization can make stale.
const exclusions = [
  { file: "features/projects/components/column.tsx", component: "BoardColumn" },
  { file: "features/tasks/components/runs/runs.tsx", component: "TaskRuns" },
].map((entry) => ({
  ...entry,
  category: "IncompatibleLibrary",
  reason: "Use of incompatible library",
  message:
    "TanStack Virtual's `useVirtualizer()` API returns functions that cannot be memoized safely",
}));

const compile = (source: string, filename: string) => {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
  });
  if (ast === null) throw new Error(`No syntax tree for ${filename}`);
  const names = new Map<string, string>();
  traverse(ast, {
    Function(path) {
      const location = path.node.loc?.start;
      if (location === undefined) return;
      const name =
        (path.isFunctionDeclaration() || path.isFunctionExpression()) && path.node.id !== null
          ? path.node.id?.name
          : path.parentPath.isVariableDeclarator() && path.parentPath.node.id.type === "Identifier"
            ? path.parentPath.node.id.name
            : undefined;
      names.set(`${location.line}:${location.column}`, name ?? "<anonymous>");
    },
  });
  const events: LoggerEvent[] = [];
  transformFromAstSync(ast, source, {
    filename,
    configFile: false,
    babelrc: false,
    plugins: [
      [
        compiler,
        {
          ...compilerOptions,
          logger: {
            logEvent: (_filename: string | null, event: LoggerEvent) => events.push(event),
          },
        },
      ],
    ],
  });
  return { events, names };
};

describe("React Compiler coverage", () => {
  it("keeps every exclusion attached to an existing source file", () => {
    for (const exclusion of exclusions)
      expect(sources.map(({ file }) => file)).toContain(exclusion.file);
  });

  it("reports successful compilation, invalid hooks, and explicit opt-outs", () => {
    const { events } = compile(
      `
      import { useRef } from "react";
      export function Compiled({ value }) { return <span>{value}</span>; }
      export function Invalid() { const ref = useRef(0); return <span>{ref.current}</span>; }
      export function OptOut() { "use no memo"; return <span />; }
    `,
      "coverage-probe.tsx",
    );
    expect(
      events.some((event) => event.kind === "CompileSuccess" && event.fnName === "Compiled"),
    ).toBe(true);
    expect(
      events.some((event) => event.kind === "CompileError" && event.detail.category === "Refs"),
    ).toBe(true);
    expect(events.some((event) => event.kind === "CompileSkip")).toBe(true);
  });

  it.each(sources)("compiles $file without unexpected skips", ({ file, source }) => {
    const filename = fileURLToPath(new URL(file, sourceRoot));
    const { events, names } = compile(source, filename);
    const failures = events.flatMap<CompilationFailure>((event) => {
      if (
        event.kind !== "CompileError" &&
        event.kind !== "CompileSkip" &&
        event.kind !== "PipelineError"
      )
        return [];
      const start = event.fnLoc?.start;
      const component = names.get(`${start?.line}:${start?.column}`) ?? "<anonymous>";
      if (event.kind !== "CompileError")
        return [
          {
            component,
            category: event.kind,
            reason: event.kind === "CompileSkip" ? event.reason : event.data,
            message: "",
          },
        ];
      const options = event.detail.options;
      return [
        {
          component,
          category: event.detail.category,
          reason: event.detail.reason,
          message:
            "details" in options
              ? options.details
                  .map((detail) => (detail.kind === "error" ? detail.message : ""))
                  .join("\n")
              : "",
        },
      ];
    });
    const expected = exclusions
      .filter((entry) => entry.file === file)
      .map(({ file: _file, ...entry }) => entry);
    // Exact equality also fails when an excluded component starts compiling or its reason changes.
    expect(failures).toEqual(expected);
    for (const excluded of expected) {
      expect(
        events.some(
          (event) => event.kind === "CompileSuccess" && event.fnName === excluded.component,
        ),
      ).toBe(false);
    }
  });
});
