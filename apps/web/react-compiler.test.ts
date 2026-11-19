import { parseSync, transformFromAstSync, traverse } from "@babel/core";
import compiler, { type LoggerEvent, type ErrorCategory } from "babel-plugin-react-compiler";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
// Effect Path has no glob matcher for lint ignore patterns.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ignorePatterns } from "../../.oxlintrc.json";
import { invalidReactDisable } from "../../tooling/oxlint/shared/react-disable";
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

const parseSource = (source: string, filename: string) => {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
  });
  if (ast === null) throw new Error(`No syntax tree for ${filename}`);
  return ast;
};

const compile = (source: string, filename: string) => {
  const ast = parseSource(source, filename);
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
  return { events, names, comments: ast.comments ?? [] };
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
    const { events, names, comments } = compile(source, filename);
    if (!ignorePatterns.some((pattern) => matchesGlob(`apps/web/src/${file}`, pattern))) {
      expect(comments.filter((comment) => invalidReactDisable(comment.value))).toEqual([]);
    }
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

describe("React disable directives", () => {
  const invalidComments = (source: string) =>
    (parseSource(source, "probe.tsx").comments ?? []).filter((comment) =>
      invalidReactDisable(comment.value),
    );

  for (const tool of ["oxlint", "eslint"]) {
    for (const hook of ["useEffect", "useMemo"]) {
      const call = `${hook}(() => {}, []);`;
      const rule = hook === "useEffect" ? "usine/no-unreasoned-effect" : "usine/no-manual-memo";
      it.each([
        `${call} // ${tool}-disable-line`,
        `// ${tool}-disable-next-line\n${call}`,
        `/* ${tool}-disable */\n${call}`,
        `/* ${tool}-disable */\n${call}\n/* ${tool}-enable */`,
        `/* ${tool}-disable usine/require-react-disable-reason */\n// ${tool}-disable-next-line ${rule}\n${call}`,
        `// ${tool}-disable-next-line usine/require-react-disable-reason -- temporary\n// ${tool}-disable-next-line ${rule}\n${call}`,
        `${call} // ${tool}-disable-line ${rule}, usine/require-react-disable-reason`,
        `${call} // ${tool}-disable-line ${rule} -- Browser events.`,
      ])("rejects %s", (source) => {
        expect(invalidComments(source).length).toBeGreaterThan(0);
      });
      it(`accepts an explained ${tool} exclusion for ${hook}`, () => {
        expect(
          invalidComments(`// ${tool}-disable-next-line ${rule} -- Browser events.\n${call}`),
        ).toEqual([]);
      });
    }
    it.each([
      `// ${tool}-disable-next-line no-console\nconsole.log("debug");`,
      `/* ${tool}-disable no-console -- Debug output. */\nconsole.log("debug");\n/* ${tool}-enable no-console */`,
      `const example = "// ${tool}-disable";`,
      `const example = <pre>{"/* ${tool}-disable */"}</pre>;`,
    ])("accepts unrelated directives and string contents: %s", (source) => {
      expect(invalidComments(source)).toEqual([]);
    });
  }
});
