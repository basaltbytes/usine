import { expect, it } from "vitest";
import { Result } from "effect";
import { entityKey } from "./entities";
import { formText, readForm } from "./forms";

it("preserves loop selectors, priority, schedule, and prompt when switching between form and text", () => {
  const key = entityKey("loop", "daily-check");
  const text =
    '---\ntrigger: { on: schedule, cron: "0 9 * * *", tz: Europe/Paris, if: "item.tick.cron != unknown" }\nagent: developer\nselector: { repos: [acme/project], tags: [app] }\napproval: required\nstep: inspect\nmax_cycles: 7\npermissions: read\npriority: 10\n---\n# Inspect\nReview {{ repo.name }} at {{ item.tick.scheduledAt }}.\n';
  const draft = readForm(key, text);
  expect(Result.isSuccess(draft)).toBe(true);
  if (Result.isFailure(draft)) return;
  const exported = formText(key, draft.success);
  expect(exported).toContain("max_cycles: 7");
  expect(exported).toContain("priority: 10");
  expect(readForm(key, exported)).toEqual(draft);
});
