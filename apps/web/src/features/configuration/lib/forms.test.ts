import { expect, it } from "vitest";
import { Result } from "effect";
import { entityKey } from "./entities";
import { formText, readForm, withField } from "./forms";

it.each(
  ["10", "-1", "'item.tick.cron == \"0 9 * * *\" ? -1 : 0'"].flatMap((priority) =>
    ["", "ci: { fix_loop: widgets/fix, timeout_seconds: 3600 }\n"].map((ci) => ({ priority, ci })),
  ),
)(
  "preserves priority $priority and CI policy '$ci' when switching between form and text",
  ({ priority, ci }) => {
    const key = entityKey("loop", "daily-check");
    const text =
      '---\ntrigger: { on: schedule, cron: "0 9 * * *", tz: Europe/Paris, if: "item.tick.cron != unknown" }\nagent: developer\nselector: { repos: [acme/project], tags: [app] }\napproval: required\nstep: inspect\nmax_cycles: 7\npermissions: read\npriority: 10\n---\n# Inspect\nReview {{ repo.name }} at {{ item.tick.scheduledAt }}.\n';
    const draft = readForm(key, text.replace("priority: 10", `${ci}priority: ${priority}`));
    expect(Result.isSuccess(draft)).toBe(true);
    if (Result.isFailure(draft)) return;
    const exported = formText(key, draft.success);
    expect(exported).toContain("max_cycles: 7");
    expect(exported).toContain("priority:");
    expect(exported).not.toContain("outcome_labels");
    expect(readForm(key, exported)).toEqual(draft);
  },
);

it("preserves project repository order and lanes through form/text edits", () => {
  const key = entityKey("project", "product");
  const draft = readForm(
    key,
    "id: product\nname: Product\nrepositories: [acme/api, acme/web]\nlanes: [{ name: Ready, sources: [{ label: ready }] }]\n",
  );
  expect(Result.isSuccess(draft)).toBe(true);
  if (Result.isFailure(draft)) return;
  expect(readForm(key, formText(key, draft.success))).toEqual(draft);
});

it("preserves required outcome labels when editing another field in a PR loop", () => {
  const key = entityKey("loop", "review-pr");
  const draft = readForm(
    key,
    "---\ntrigger: { on: pr, if: 'true' }\nagent: reviewer\noutcome_labels: [ready-to-merge, agent-review-findings]\n---\nReview the pull request.\n",
  );
  expect(Result.isSuccess(draft)).toBe(true);
  if (Result.isFailure(draft)) return;
  const edited = withField(draft.success, "maxCycles", 5);
  const exported = formText(key, edited);
  expect(exported).toContain("outcome_labels:");
  const restored = readForm(key, exported);
  expect(restored).toEqual(Result.succeed(edited));
  if (Result.isFailure(restored)) return;
  expect(restored.success.outcomeLabels).toEqual(["ready-to-merge", "agent-review-findings"]);
});

it("preserves an agent's coordinator and decision brain through form/text edits", () => {
  const key = entityKey("agent", "developer");
  const draft = readForm(
    key,
    "---\nharness: codex\nmodel: gpt-5.6-sol\neffort: high\ncoordinator: events\ndecision:\n  model: gpt-5.6-terra\n  effort: low\n---\nImplement the issue.\n",
  );
  expect(Result.isSuccess(draft)).toBe(true);
  if (Result.isFailure(draft)) return;
  expect(draft.success.coordinator).toBe("events");
  expect(readForm(key, formText(key, draft.success))).toEqual(draft);
  const inherited = withField(draft.success, "coordinator", undefined);
  expect(formText(key, inherited)).not.toContain("coordinator:");
});
