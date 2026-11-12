import { assert, it } from "@effect/vitest";
import { AttemptTask } from "@usine/core/attempt";
import { CiPolicy } from "@usine/core/ci";
import { LoopName } from "@usine/core/loop";
import { Option, Schema } from "effect";
import { recordedPrompt, withCiInstructions } from "../src/trigger-submission.ts";

const policy = CiPolicy.make({ fixLoop: LoopName.make("fix"), timeoutSeconds: 1800 });
const prompt = "Fix the failing checks.";

it("records the CI handoff instructions apart from the prompt they end", () => {
  const { task, ciInstructions } = withCiInstructions(prompt, Option.some(policy));
  assert(Option.isSome(ciInstructions));
  assert.strictEqual(task, `${prompt}${ciInstructions.value}`);
  assert.include(ciInstructions.value, 'fix_loop ("fix")');
  assert.deepStrictEqual(withCiInstructions(prompt, Option.none()), {
    task: AttemptTask.make(prompt),
    ciInstructions: Option.none(),
  });
});

it("removes the recorded CI handoff instructions, whatever their wording", () => {
  const earlier = Schema.NonEmptyString.make("\n\nAn earlier wording of the CI handoff.");
  const recorded = {
    task: AttemptTask.make(`${prompt}${earlier}`),
    ciInstructions: Option.some(earlier),
    ciPolicy: Option.some(policy),
  };
  assert.deepStrictEqual(recordedPrompt(recorded), { prompt, removed: "recorded" });
  const replaced = withCiInstructions(recordedPrompt(recorded).prompt, Option.some(policy));
  assert.notInclude(replaced.task, earlier);
  assert.strictEqual(replaced.task.split("After pushing, end with").length, 2);
});

it("removes the current CI handoff instructions from an Event recorded without them", () => {
  const { task } = withCiInstructions(prompt, Option.some(policy));
  assert.deepStrictEqual(
    recordedPrompt({ task, ciInstructions: Option.none(), ciPolicy: Option.some(policy) }),
    { prompt, removed: "current-wording" },
  );
  assert.deepStrictEqual(
    recordedPrompt({
      task: AttemptTask.make(prompt),
      ciInstructions: Option.none(),
      ciPolicy: Option.some(policy),
    }),
    { prompt, removed: "none" },
  );
});

it("leaves the task unchanged when the CI handoff instructions aren't its end", () => {
  const current = withCiInstructions("", Option.some(policy)).ciInstructions;
  assert(Option.isSome(current));
  const earlier = "\n\nAn earlier wording of the CI handoff.";
  // A legacy Event that quotes today's wording earlier, as a CI log excerpt can, and ends with
  // an older wording.
  const quoting = AttemptTask.make(`${prompt}${current.value}\n\nLog excerpt.${earlier}`);
  assert.deepStrictEqual(
    recordedPrompt({ task: quoting, ciInstructions: Option.none(), ciPolicy: Option.some(policy) }),
    { prompt: quoting, removed: "none" },
  );
  // Recorded instructions that more text follows.
  const amended = AttemptTask.make(`${prompt}${current.value}\n\nAn amendment.`);
  assert.deepStrictEqual(
    recordedPrompt({ task: amended, ciInstructions: current, ciPolicy: Option.some(policy) }),
    { prompt: amended, removed: "none" },
  );
});
