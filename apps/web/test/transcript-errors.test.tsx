import { TranscriptSequence } from "@usine/engine/transcript";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { ErrorControls } from "../src/run-transcript/navigation/errors.tsx";
import type { TranscriptUpdate } from "../src/run-transcript/navigation/model.ts";

const error = (sequence: number): TranscriptUpdate => ({
  key: `event:${sequence}`,
  sequence: TranscriptSequence.make(sequence),
  latestSequence: TranscriptSequence.make(sequence),
  isError: true,
  childKey: null,
  isTool: false,
});

it("keeps the selected error identified when earlier history and new errors arrive", () => {
  const selected = error(5);
  const initial = renderToStaticMarkup(
    <ErrorControls
      errors={[error(3), selected]}
      selectedKey={selected.key}
      earlier
      onSelect={() => {}}
    />,
  );
  const expanded = renderToStaticMarkup(
    <ErrorControls
      errors={[error(1), error(3), selected, error(7)]}
      selectedKey={selected.key}
      earlier
      onSelect={() => {}}
    />,
  );

  assert.include(initial, "2 of 2 loaded errors");
  assert.include(expanded, "3 of 4 loaded errors");
});

it("distinguishes a complete error count from an incompletely loaded transcript", () => {
  const html = renderToStaticMarkup(
    <ErrorControls errors={[error(1)]} selectedKey={null} earlier={false} onSelect={() => {}} />,
  );

  assert.include(html, "1 error");
  assert.include(html, 'aria-label="Previous error"');
  assert.include(html, 'aria-label="Next error"');
});
