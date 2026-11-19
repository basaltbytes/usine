import { Option } from "effect";
import { expect, it } from "vitest";
import { codeReference, textReferences } from "~/lib/references/syntax";

const run = "0f3c9a1b2d4e5f60718293a4b5c6d7e8";

it("finds tasks and run IDs in prose, with the text that writes each", () => {
  expect(
    textReferences(`Merged (#1304), then basaltbytes/usine#12 and run ${run}.`).map((part) =>
      part._tag === "Text" ? part.text : [part.text, part.reference],
    ),
  ).toEqual([
    "Merged (",
    ["#1304", { _tag: "Task", repository: null, number: 1304 }],
    "), then ",
    ["basaltbytes/usine#12", { _tag: "Task", repository: "basaltbytes/usine", number: 12 }],
    " and run ",
    [run, { _tag: "Run", run }],
    ".",
  ]);
});

it("leaves numbers and IDs inside words, paths, and longer IDs as text", () => {
  for (const text of [
    "C#1 and PR#12",
    "issue-#3",
    "a/b/c#4",
    "#0 and #12a",
    `${run}0 is a longer ID`,
    `x${run}`,
    "commit 0f3c9a1b2d4e5f60718293a4b5c6d7e8f9a0b1c2",
  ])
    expect(textReferences(text).every(({ _tag }) => _tag === "Text")).toBe(true);
});

it("reads a code span as a task, a source line, or a name", () => {
  expect(codeReference("#40")).toEqual(Option.some({ _tag: "Task", repository: null, number: 40 }));
  expect(
    codeReference(" basaltbytes/usine/packages/executor/src/supervisor/storage.ts:36 "),
  ).toEqual(
    Option.some({
      _tag: "Source",
      path: "basaltbytes/usine/packages/executor/src/supervisor/storage.ts",
      line: 36,
      end: null,
    }),
  );
  expect(codeReference("acme/app/src/a.ts:8-12")).toEqual(
    Option.some({ _tag: "Source", path: "acme/app/src/a.ts", line: 8, end: 12 }),
  );
  expect(codeReference("acme/app/src/a.ts:8-3")).toEqual(
    Option.some({ _tag: "Source", path: "acme/app/src/a.ts", line: 8, end: null }),
  );
  expect(codeReference("ready-for-agent")).toEqual(
    Option.some({ _tag: "Name", name: "ready-for-agent" }),
  );
  expect(codeReference("usine/implement")).toEqual(
    Option.some({ _tag: "Name", name: "usine/implement" }),
  );
});

it("leaves a code span that can't be a reference as code", () => {
  for (const code of ["", "const x = () => 1;", "x".repeat(101), "-flag", "a b`c"])
    expect(codeReference(code)).toEqual(Option.none());
});
