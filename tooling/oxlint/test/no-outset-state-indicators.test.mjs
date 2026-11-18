import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

const cn = 'import { cn } from "~/lib/utils";\n';

for (const [name, source] of [
  [
    "a focus ring without ring-inset",
    'export const A = () => <a href="/" className="focus-visible:ring-2 focus-visible:ring-ring/70" />;',
  ],
  [
    "a has-focus ring without ring-inset",
    'export const A = () => <tr className="has-[:focus-visible]:ring-2" />;',
  ],
  [
    "a ring-inset under another variant",
    'export const A = () => <a href="/" className="hover:ring-inset focus-visible:ring-2" />;',
  ],
  [
    "a positive outline offset",
    'export const A = () => <a href="/" className="focus-visible:outline-2 focus-visible:outline-offset-2" />;',
  ],
  [
    "a ring-inset that applies only in one branch",
    `${cn}export const A = (open: boolean) => <a href="/" className={cn("focus-visible:ring-2", open && "ring-inset")} />;`,
  ],
]) {
  test(`rejects ${name}`, () => {
    const result = lint("components/example.tsx", source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-outset-state-indicators/u);
  });
}

for (const [name, source] of [
  [
    "an inset focus ring",
    'export const A = () => <a href="/" className="focus-visible:ring-2 focus-visible:ring-inset" />;',
  ],
  [
    "a ring-inset in another argument of cn",
    `${cn}export const A = (open: boolean) => <a href="/" className={cn("ring-inset", open && "focus-visible:ring-2")} />;`,
  ],
  ["a resting hairline ring", 'export const A = () => <div className="ring-1 ring-border" />;'],
  [
    "a focus ring color",
    'export const A = () => <a href="/" className="focus-visible:ring-ring/70" />;',
  ],
  [
    "an outline without offset or with a negative one",
    'export const A = () => <a href="/" className="focus-visible:outline-2 focus-visible:-outline-offset-2" />;',
  ],
  ["a zero outline offset", 'export const A = () => <a href="/" className="outline-offset-0" />;'],
]) {
  test(`allows ${name}`, () => {
    const result = lint("components/example.tsx", source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
