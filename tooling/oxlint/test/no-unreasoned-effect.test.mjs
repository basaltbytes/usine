import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

for (const [name, source] of [
  [
    "useEffect",
    'import { useEffect } from "react"; export const useValue = () => { useEffect(() => {}, []); };',
  ],
  [
    "aliased useLayoutEffect",
    'import { useLayoutEffect as sync } from "react"; export const useValue = () => { sync(() => {}, []); };',
  ],
  [
    "namespace effect",
    'import * as React from "react"; export const useValue = () => { React.useEffect(() => {}, []); };',
  ],
  [
    "computed effect",
    'import React from "react"; export const useValue = () => { React["useLayoutEffect"](() => {}, []); };',
  ],
]) {
  test(`rejects unexplained ${name}`, () => {
    const result = lint("hooks/example.ts", source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-unreasoned-effect/u);
  });
}

test("allows a documented browser event subscription", () => {
  const result = lint(
    "hooks/example.ts",
    `import { useEffect } from "react";
export const useValue = (listener: () => void) => {
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Subscribe to browser resize events.
  useEffect(() => {
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }, [listener]);
};`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("allows unrelated functions with the same name", () => {
  const result = lint(
    "hooks/example.ts",
    'import { useEffect } from "other"; export const value = useEffect();',
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [name, directive] of [
  ["bare exclusion", "// oxlint-disable-next-line usine/no-unreasoned-effect"],
  ["empty reason", "// oxlint-disable-next-line usine/no-unreasoned-effect --"],
  ["file-wide exclusion", "/* oxlint-disable usine/no-unreasoned-effect */"],
  ["blanket exclusion", "// oxlint-disable-next-line"],
  ["blanket exclusion with reason", "// oxlint-disable-next-line -- Browser events."],
  [
    "file-wide exclusion with reason",
    "/* oxlint-disable usine/no-unreasoned-effect -- Browser events. */",
  ],
  [
    "same-line exclusion",
    "/* oxlint-disable-line usine/no-unreasoned-effect -- Browser events. */",
  ],
  ["eslint exclusion without reason", "// eslint-disable-next-line usine/no-unreasoned-effect"],
]) {
  test(`rejects ${name}`, () => {
    const result = lint(
      "hooks/example.ts",
      `import { useEffect } from "react";
${directive}
export const useValue = () => useEffect(() => {}, []);`,
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /require-react-disable-reason/u);
  });
}
