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
  assert.strictEqual(recordedPrompt(recorded), prompt);
  const replaced = withCiInstructions(recordedPrompt(recorded), Option.some(policy));
  assert.notInclude(replaced.task, earlier);
  assert.strictEqual(replaced.task.split("After pushing, end with").length, 2);
});

it("removes the current CI handoff instructions from an Event recorded without them", () => {
  const { task } = withCiInstructions(prompt, Option.some(policy));
  assert.strictEqual(
    recordedPrompt({ task, ciInstructions: Option.none(), ciPolicy: Option.some(policy) }),
    prompt,
  );
  assert.strictEqual(
    recordedPrompt({
      task: AttemptTask.make(prompt),
      ciInstructions: Option.none(),
      ciPolicy: Option.some(policy),
    }),
    prompt,
  );
});
