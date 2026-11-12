import { ProjectId } from "@usine/core/project";
import { BoardLaneId } from "@usine/orchestrator/operator";
import { assert, it } from "vitest";
import { laneFoldMemory } from "~/features/projects/lib/folds";

const project = ProjectId.make("board-test");
const unmapped = BoardLaneId.make("fallback:unmapped");
const done = BoardLaneId.make("done");
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
  };
};

it("restores each lane's latest choice per project and returns null for a lane never chosen", () => {
  const browser = storage();
  laneFoldMemory(() => browser).write(project, unmapped, true);
  laneFoldMemory(() => browser).write(project, done, false);
  laneFoldMemory(() => browser).write(project, unmapped, false);

  const reopened = laneFoldMemory(() => browser);
  assert.isFalse(reopened.read(project, unmapped));
  assert.isFalse(reopened.read(project, done));
  assert.isNull(reopened.read(ProjectId.make("other"), unmapped));
});

it("keeps the 200 most recent choices", () => {
  const browser = storage();
  const memory = laneFoldMemory(() => browser);
  for (let index = 0; index < 201; index += 1)
    memory.write(project, BoardLaneId.make(`lane-${index}`), true);
  assert.isNull(memory.read(project, BoardLaneId.make("lane-0")));
  assert.isTrue(memory.read(project, BoardLaneId.make("lane-1")));
  assert.isTrue(memory.read(project, BoardLaneId.make("lane-200")));
});

it.each(["broken json", '{"version":99,"lanes":[]}', "x".repeat(64_001)])(
  "ignores corrupt, unsupported, and oversized browser data without preventing future saves",
  (corrupt) => {
    const browser = storage();
    const memory = laneFoldMemory(() => browser);
    memory.write(project, unmapped, true);
    browser.replace(corrupt);
    assert.isNull(memory.read(project, unmapped));
    memory.write(project, unmapped, true);
    assert.isTrue(memory.read(project, unmapped));
  },
);

it("skips persistence when the browser denies storage", () => {
  const memory = laneFoldMemory(() => {
    throw new Error("SecurityError");
  });
  memory.write(project, unmapped, true);
  assert.isNull(memory.read(project, unmapped));
});
