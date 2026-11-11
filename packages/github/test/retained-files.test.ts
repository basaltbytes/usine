import { assert, it } from "@effect/vitest";
import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import { ChangedFile, CommitRangeFilesQuery, FileChanges, FileRead } from "../src/files/model.ts";
import { RetainedFiles, retainedBytes } from "../src/files/retained.ts";

const base = CommitSha.make("b".repeat(40));
const read = (head: string) =>
  FileRead.make({
    repository: RepositoryName.make("basaltbytes/usine"),
    item: ItemNumber.make(42),
    selection: CommitRangeFilesQuery.make({ base, head: CommitSha.make(head.repeat(40)) }),
  });
// Holds 2 * (4 + 46) = 100 bytes of path and patch text.
const file = ChangedFile.make({
  path: "a.ts",
  oldPath: null,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: { kind: "text", text: `@@ -1 +1 @@\n+${"x".repeat(33)}`, truncated: false },
  test: false,
  generated: false,
});
const changes = (head: string, files = [file]) =>
  FileChanges.make({ base, head: CommitSha.make(head.repeat(40)), files, filesTruncated: false });

it("weighs paths and patch text, and ignores omitted patches", () => {
  assert.strictEqual(retainedBytes(changes("a")), 100);
  const renamed = ChangedFile.make({ ...file, oldPath: "old.ts", patch: { kind: "omitted" } });
  assert.strictEqual(retainedBytes(changes("a", [renamed])), 2 * (4 + 6));
});

it("evicts the least recently read responses until a new one fits the byte budget", () => {
  const retained = new RetainedFiles(250);
  assert.deepStrictEqual(retained.retain(read("a"), changes("a")), {
    _tag: "Retained",
    bytes: 100,
    evicted: 0,
  });
  retained.retain(read("c"), changes("c"));
  assert.isTrue(Option.isSome(retained.get(read("a"))));
  assert.deepStrictEqual(retained.retain(read("d"), changes("d")), {
    _tag: "Retained",
    bytes: 100,
    evicted: 1,
  });
  assert.isTrue(Option.isNone(retained.get(read("c"))));
  assert.isTrue(Option.isSome(retained.get(read("a"))));
  assert.isTrue(Option.isSome(retained.get(read("d"))));
  assert.strictEqual(retained.used, 200);
});

it("replaces a retained selection without counting it twice", () => {
  const retained = new RetainedFiles(150);
  retained.retain(read("a"), changes("a"));
  assert.deepStrictEqual(retained.retain(read("a"), changes("a")), {
    _tag: "Retained",
    bytes: 100,
    evicted: 0,
  });
  assert.strictEqual(retained.used, 100);
});

it("returns a response larger than the whole budget without evicting others", () => {
  const retained = new RetainedFiles(99);
  assert.deepStrictEqual(retained.retain(read("a"), changes("a")), {
    _tag: "Oversized",
    bytes: 100,
  });
  assert.isTrue(Option.isNone(retained.get(read("a"))));
  assert.strictEqual(retained.used, 0);
});
