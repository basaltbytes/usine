import { createHash } from "node:crypto";
import type { FactoryOverview, DeskView, ConfigurationView } from "@usine/orchestrator/operator";
import type { Option } from "effect";
import type { UpgradeView } from "@usine/orchestrator/operator/http";
import type { ChangeTarget } from "@usine/orchestrator/operator/http";

export type Snapshot = ReadonlyMap<
  string,
  { readonly target: ChangeTarget; readonly hash: string }
>;

/** Fingerprints authorized projections without keeping their payloads in the replay journal. */
export const snapshot = (
  overview: FactoryOverview,
  desk: DeskView,
  configuration: ConfigurationView,
  upgrade: Option.Option<UpgradeView>,
): Snapshot => {
  const entries = new Map<string, { readonly target: ChangeTarget; readonly hash: string }>();
  const add = <A>(kind: ChangeTarget["kind"], id: string, value: A) => {
    entries.set(`${kind}:${id}`, {
      target: { kind, id },
      hash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    });
  };
  for (const project of overview.projects) {
    const id =
      project.id ??
      project.repository
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "");
    add("project", id, project);
    for (const lane of project.board.lanes)
      for (const item of lane.items)
        for (const member of item.items) add("item", member.itemKey, item);
    for (const run of project.runs) {
      add("run", run.id, run);
      for (const attempt of run.attempts) add("attempt", attempt.id, attempt);
    }
  }
  for (const running of desk.running) {
    add("run", running.run.id, running);
    add("attempt", running.attempt.id, running);
  }
  for (const worker of desk.workers) add("worker", worker.name, worker);
  add(
    "navigation",
    "instance",
    overview.projects.map((project) => [
      project.id,
      project.name,
      project.status,
      project.runs,
      project.board.lanes.flatMap(({ items }) =>
        items.map(({ itemKey, title, state, items }) => [itemKey, title, state, items]),
      ),
    ]),
  );
  add("configuration", "instance", [configuration, upgrade]);
  add("attention", "instance", [
    overview._tag,
    overview.needsYou,
    overview.dismissedNeeds,
    overview.loops,
  ]);
  // Poll completion times advance even when GitHub returns identical items.
  add("activity", "instance", [desk.running, desk.notMoving, desk.lastOutcomes]);
  return entries;
};

export const changedTargets = (before: Snapshot, after: Snapshot): ReadonlyArray<ChangeTarget> => {
  const changed = new Map<string, ChangeTarget>();
  for (const [key, entry] of after)
    if (before.get(key)?.hash !== entry.hash) changed.set(key, entry.target);
  for (const [key, entry] of before) if (!after.has(key)) changed.set(key, entry.target);
  return [...changed.values()];
};
