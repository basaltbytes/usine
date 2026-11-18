import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

for (const [name, source] of [
  ["a global ResizeObserver", "export const observe = (f: () => void) => new ResizeObserver(f);"],
  [
    "a ResizeObserver read from window",
    "export const observe = (f: () => void) => new window.ResizeObserver(f);",
  ],
  [
    "a ResizeObserver read from globalThis by name",
    'export const observe = (f: () => void) => new globalThis["ResizeObserver"](f);',
  ],
]) {
  test(`rejects ${name}`, () => {
    const result = lint("hooks/example.ts", source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-raw-resize-observer/u);
  });
}

test("allows other observers", () => {
  const result = lint(
    "hooks/example.ts",
    "export const observe = (f: () => void) => new MutationObserver(f);",
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
