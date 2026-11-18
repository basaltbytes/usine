import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

for (const [name, source] of [
  ["a title on a span", 'export const A = () => <span title="Total attempt time">2m</span>;'],
  ["an expression title on a button", "export const A = (t: string) => <button title={t} />;"],
]) {
  test(`rejects ${name}`, () => {
    const result = lint("components/example.tsx", source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-native-title-tooltip/u);
  });
}

for (const [name, source] of [
  [
    "a component's title prop",
    'const Page = (props: { readonly title: string }) => <h1>{props.title}</h1>;\nexport const A = () => <Page title="Tasks" />;',
  ],
  ["a title on an iframe", 'export const A = () => <iframe title="Preview" src="/x" />;'],
]) {
  test(`allows ${name}`, () => {
    const result = lint("components/example.tsx", source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
