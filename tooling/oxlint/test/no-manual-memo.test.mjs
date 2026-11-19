import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "./lint.mjs";

for (const [name, source] of [
  [
    "useMemo",
    'import { useMemo } from "react"; export const useValue = () => useMemo(() => 1, []);',
  ],
  [
    "aliased useCallback",
    'import { useCallback as cache } from "react"; export const useValue = () => cache(() => 1, []);',
  ],
  [
    "namespace useMemo",
    'import * as React from "react"; export const useValue = () => React.useMemo(() => 1, []);',
  ],
  [
    "computed useCallback",
    'import React from "react"; export const useValue = () => React["useCallback"](() => 1, []);',
  ],
  ["memo", 'import { memo } from "react"; export const View = memo(() => null);'],
]) {
  test(`rejects ${name}`, () => {
    const result = lint("hooks/example.ts", source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-manual-memo/u);
  });
}

for (const [name, source] of [
  ["ordinary functions", "export const useValue = () => 1;"],
  ["unrelated imports", 'import { memo } from "other"; export const value = memo(1);'],
  [
    "shadowed imports",
    'import * as React from "react"; export const useValue = (React: { useMemo: () => number }) => React.useMemo(); export { React };',
  ],
  [
    "compiler exclusion",
    'import { useMemo } from "react";\n// oxlint-disable-next-line usine/no-manual-memo -- IncompatibleLibrary: useVirtualizer returns functions that cannot be memoized safely.\nexport const useValue = () => useMemo(() => 1, []);',
  ],
]) {
  test(`allows ${name}`, () => {
    const result = lint("hooks/example.ts", source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

for (const [name, directive] of [
  ["bare exclusion", "// oxlint-disable-next-line usine/no-manual-memo"],
  ["empty reason", "// oxlint-disable-next-line usine/no-manual-memo --"],
  ["file-wide exclusion", "/* oxlint-disable usine/no-manual-memo */"],
  ["blanket exclusion", "// oxlint-disable-next-line"],
  ["blanket exclusion with reason", "// oxlint-disable-next-line -- Browser events."],
  [
    "file-wide exclusion with reason",
    "/* oxlint-disable usine/no-manual-memo -- Browser events. */",
  ],
  ["same-line exclusion", "/* oxlint-disable-line usine/no-manual-memo -- Browser events. */"],
  ["eslint exclusion without reason", "// eslint-disable-next-line usine/no-manual-memo"],
]) {
  test(`rejects ${name}`, () => {
    const result = lint(
      "hooks/example.ts",
      `import { useMemo } from "react";
${directive}
export const useValue = () => useMemo(() => {}, []);`,
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /require-react-disable-reason/u);
  });
}
