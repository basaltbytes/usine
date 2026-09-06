import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { assert, it } from "vitest";
import { ReaderBookmark, readerMemory } from "../src/run-transcript/reader/memory.ts";

const runId = RunId.make("run-one");
const bookmark = ReaderBookmark.make({
  filter: "tools",
  disclosures: [{ key: "call-one", open: true, groupOpen: true }],
  position: {
    _tag: "Anchor",
    key: "call-one",
    surface: "result",
    sequence: TranscriptSequence.make(42),
    offset: -87,
  },
  readThrough: TranscriptSequence.make(95),
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    replace: (value: string) => {
      for (const key of values.keys()) values.set(key, value);
    },
    serialized: () => [...values.values()].join(""),
  };
};

it("restores a Run's inspected location and keeps other Runs and latest independent", () => {
  const browser = storage();
  readerMemory(() => browser).write(runId, bookmark, 100);
  const second = RunId.make("run-two");
  const latest = ReaderBookmark.make({
    ...bookmark,
    filter: "messages",
    position: { _tag: "Latest" },
    disclosures: [],
  });
  readerMemory(() => browser).write(second, latest, 110);

  const reopened = readerMemory(() => browser);
  assert.deepEqual(reopened.read(runId, 120), bookmark);
  assert.deepEqual(reopened.read(second, 120), latest);
  assert.isNull(reopened.read(RunId.make("unvisited"), 120));
});

it.each(["broken json", '{"version":99,"runs":[]}', "x".repeat(512_001)])(
  "ignores corrupt, unsupported and oversized browser data without preventing future saves",
  (corrupt) => {
    const browser = storage();
    const memory = readerMemory(() => browser);
    memory.write(runId, bookmark, 100);
    browser.replace(corrupt);
    assert.isNull(memory.read(runId, 110));
    memory.write(runId, bookmark, 120);
    assert.deepEqual(memory.read(runId, 130), bookmark);
  },
);

it("rejects invalid offsets and unknown stored fields at the storage boundary", () => {
  const browser = storage();
  const memory = readerMemory(() => browser);
  memory.write(runId, bookmark, 100);
  const original = browser.serialized();
  browser.replace(original.replace('"offset":-87', '"offset":1e100'));
  assert.isNull(memory.read(runId, 110));
  browser.replace(original.replace('"filter":"tools"', '"filter":"tools","payload":"private"'));
  assert.isNull(memory.read(runId, 110));
});

it("bounds saved Runs and expires stale or future-dated bookmarks", () => {
  const browser = storage();
  const memory = readerMemory(() => browser);
  memory.write(runId, bookmark, 100);
  assert.isNull(memory.read(runId, 99));
  assert.isNull(memory.read(runId, 100 + 31 * 86_400_000));
  for (let index = 0; index < 25; index++)
    memory.write(RunId.make(`run-${index}`), bookmark, 200 + index);
  assert.isNull(memory.read(runId, 230));
  assert.isNull(memory.read(RunId.make("run-0"), 230));
  assert.deepEqual(memory.read(RunId.make("run-24"), 230), bookmark);
});

it("survives denied storage access, failed reads and exhausted quota", () => {
  const denied = () => {
    throw new DOMException("Denied", "SecurityError");
  };
  const inaccessible = readerMemory(denied);
  assert.isNull(inaccessible.read(runId, 100));
  assert.doesNotThrow(() => inaccessible.write(runId, bookmark, 100));
  const unreadable = readerMemory(() => ({ getItem: denied, setItem: () => {} }));
  assert.isNull(unreadable.read(runId, 100));
  const quota = readerMemory(() => ({ getItem: () => null, setItem: denied }));
  assert.doesNotThrow(() => quota.write(runId, bookmark, 100));
});
