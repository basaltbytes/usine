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
