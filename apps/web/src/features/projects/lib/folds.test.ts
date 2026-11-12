import { ProjectId } from "@usine/core/project";
import { BoardLaneId } from "@usine/orchestrator/operator";
import { afterEach, assert, it, vi } from "vitest";
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
    serialized: () => [...values.values()].join(""),
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

const warnings = () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () =>
    log.mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((line) => line.includes("WARN"));
};

afterEach(() => {
  vi.restoreAllMocks();
});

const saved = (lane: BoardLaneId) =>
  JSON.stringify({ version: 1, lanes: [{ project, lane, folded: true }] });

it.each([
  ["corrupt", "broken json"],
  ["unsupported", '{"version":99,"lanes":[]}'],
  ["oversized", saved(unmapped) + " ".repeat(64_000)],
])("logs and discards %s browser data, and the next save replaces it", (_reason, discarded) => {
  const browser = storage();
  const memory = laneFoldMemory(() => browser);
  memory.write(project, unmapped, false);
  browser.replace(discarded);
  const logged = warnings();
  assert.isNull(memory.read(project, unmapped));
  assert.lengthOf(logged(), 1);
  assert.include(logged()[0], "Board lane fold storage discarded");
  memory.write(project, unmapped, true);
  assert.isTrue(memory.read(project, unmapped));
});

it("drops the oldest choices until the saved archive fits 64,000 characters", () => {
  const browser = storage();
  const memory = laneFoldMemory(() => browser);
  const lane = (index: number) => BoardLaneId.make(`${"x".repeat(500)}-${index}`);
  for (let index = 0; index < 200; index += 1) memory.write(project, lane(index), true);
  assert.isAtMost(browser.serialized().length, 64_000);
  assert.isTrue(memory.read(project, lane(199)));
  assert.isNull(memory.read(project, lane(0)));
});

it("logs and skips persistence when the browser denies storage", () => {
  const logged = warnings();
  const memory = laneFoldMemory(() => {
    throw new Error("SecurityError");
  });
  memory.write(project, unmapped, true);
  assert.isNull(memory.read(project, unmapped));
  assert.lengthOf(logged(), 2);
  for (const line of logged()) assert.include(line, "Board lane fold storage unavailable");
});
