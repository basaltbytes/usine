import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

const dash = "—";

for (const [name, filename, source] of [
  ["JSX text", "components/example.tsx", `export const A = () => <p>Done ${dash} merged</p>;`],
  [
    "a string rendered in JSX",
    "components/example.tsx",
    `export const A = (empty: boolean) => <p>{empty ? "${dash}" : "x"}</p>;`,
  ],
  [
    "a template in a JSX attribute",
    "components/example.tsx",
    `export const A = (n: number) => <p aria-label={\`\${n} ${dash} runs\`} />;`,
  ],
  ["a strings.ts value", "features/tasks/strings.ts", `export const empty = "${dash}";`],
]) {
  test(`rejects ${name}`, () => {
    const result = lint(filename, source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-em-dash-copy/u);
  });
}

for (const [name, filename, source] of [
  [
    "a regular expression",
    "lib/example.ts",
    `export const clause = (s: string) => /\\s${dash}\\s/u.exec(s);`,
  ],
  ["a string outside markup", "lib/example.ts", `export const separator = " ${dash} ";`],
  [
    "a comment",
    "components/example.tsx",
    `// Before ${dash} after.\nexport const A = () => <p />;`,
  ],
  ["an en dash", "components/example.tsx", "export const A = () => <p>1–2</p>;"],
]) {
  test(`allows ${name}`, () => {
    const result = lint(filename, source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
