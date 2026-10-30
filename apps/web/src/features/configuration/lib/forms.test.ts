import { expect, it } from "vitest";
import { Result } from "effect";
import { entityKey } from "./entities";
import { formText, readForm } from "./forms";

it.each(["10", "-1", "'item.tick.cron == \"0 9 * * *\" ? -1 : 0'"])(
  "preserves priority %s and loop fields when switching between form and text",
  (priority) => {
    const key = entityKey("loop", "daily-check");
    const text =
      '---\ntrigger: { on: schedule, cron: "0 9 * * *", tz: Europe/Paris, if: "item.tick.cron != unknown" }\nagent: developer\nselector: { repos: [acme/project], tags: [app] }\napproval: required\nstep: inspect\nmax_cycles: 7\npermissions: read\npriority: 10\n---\n# Inspect\nReview {{ repo.name }} at {{ item.tick.scheduledAt }}.\n';
    const draft = readForm(key, text.replace("priority: 10", `priority: ${priority}`));
    expect(Result.isSuccess(draft)).toBe(true);
    if (Result.isFailure(draft)) return;
    const exported = formText(key, draft.success);
    expect(exported).toContain("max_cycles: 7");
    expect(exported).toContain("priority:");
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
