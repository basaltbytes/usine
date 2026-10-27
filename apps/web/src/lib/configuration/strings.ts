import type { InstanceReload } from "@usine/orchestrator/current-instance";

/** Returns one line per kind of change from an accepted reload, or `Nothing changed`. */
export const reloadChanges = (reload: InstanceReload): ReadonlyArray<string> => {
  const named = [
    ["Loops", reload.loops],
    ["Agents", reload.agents],
    ["Labels", reload.labels],
    ["Repositories", reload.repos],
    ["Workers", reload.workers],
  ] as const;
  const lines = named.flatMap(([subject, { added, removed, changed }]) =>
    (
      [
        ["added", added],
        ["removed", removed],
        ["changed", changed],
      ] as const
    ).flatMap(([verb, names]) =>
      names.length === 0 ? [] : [`${subject} ${verb}: ${names.join(", ")}`],
    ),
  );
  if (reload.settingsChanged) lines.push("Settings changed");
  if (reload.operatorChanged) lines.push("Operator login changed");
  if (lines.length === 0) lines.push("Nothing changed");
  return lines;
};

/** Returns the reload changes, followed by the files the reload skipped. */
export const reloadSummary = (reload: InstanceReload): ReadonlyArray<string> => {
  const lines = [...reloadChanges(reload)];
  const leftOut = reload.quarantinedLoops.length + reload.invalidAgents.length;
  if (leftOut > 0) {
    lines.push(
      leftOut === 1
        ? "1 file not loaded, listed in Needs attention"
        : `${leftOut} files not loaded, listed in Needs attention`,
    );
  }
  return lines;
};
