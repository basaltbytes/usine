import { assert, describe, it } from "@effect/vitest";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { Option, Schema } from "effect";
import {
  AgentBlockedError,
  AgentCapacityError,
  harnessFailure,
  reportedOutcome,
  reportText,
  AgentQuestionError,
  AgentResultError,
  ChildSessionBudgetExceededError,
  ContinuationLimitError,
  PoolUnavailableError,
  SessionInterruptedError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  UnsupportedEffortError,
} from "../src/runtime.ts";

describe("agent runtime contract", () => {
  it("retries SDK trouble as infrastructure and parks everything else on the operator", () => {
    const sessionId = Option.some(AgentSessionId.make("child-1"));
    const infra = toAttemptFailure(
      SessionOperationError.make({
        operation: "stream",
        sessionId,
        message: "Claude output stream failed",
        cause: new Error("socket closed"),
      }),
    );
    assert.strictEqual(infra._tag, "InfraFailure");

    const interrupted = toAttemptFailure(
      SessionInterruptedError.make({
        sessionId: AgentSessionId.make("child-1"),
        message: "The saved native conversation could not be reopened",
      }),
    );
    assert.strictEqual(interrupted._tag, "InfraFailure");

    const terminal = [
      ContinuationLimitError.make({
        sessionId: AgentSessionId.make("child-1"),
        message: "The child reached its limit of three continuations within ten minutes",
      }),
      UnknownModelError.make({
        harness: Harness.make("claude"),
        model: ModelId.make("claude-never-existed"),
        message: 'Claude has no model "claude-never-existed"',
      }),
      PoolUnavailableError.make({
        harness: Harness.make("pi"),
        model: ModelId.make("github-copilot/gpt-5.6-sol"),
        pool: "apiKeys",
        message: "Pi model github-copilot/gpt-5.6-sol must use an API key",
      }),
      UnsupportedEffortError.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5.6-terra"),
        effort: "max",
        message: 'Codex model "gpt-5.6-terra" doesn\'t support effort max',
      }),
      AgentResultError.make({ sessionId, message: "ran out of turns" }),
    ];
    for (const error of terminal) {
      assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
    }

    const blocked = toAttemptFailure(
      AgentBlockedError.make({ sessionId, message: "The baseline gate fails on main." }),
    );
    assert.strictEqual(blocked._tag, "BlockedFailure");
    if (blocked._tag === "BlockedFailure") {
      assert.strictEqual(blocked.message, "The baseline gate fails on main.");
    }

    const asked = toAttemptFailure(
      AgentQuestionError.make({ sessionId, message: "Which transport should egress use?" }),
    );
    assert.strictEqual(asked._tag, "QuestionFailure");
    if (asked._tag === "QuestionFailure") {
      assert.strictEqual(asked.question, "Which transport should egress use?");
    }

    const budget = toAttemptFailure(
      ChildSessionBudgetExceededError.make({
        maxChildren: ChildSessionBudget.make(4),
        attemptedChildren: ChildSessionCount.make(5),
        message: "Attempt tried to spawn child 5 after reaching its 4-child budget",
      }),
    );
    assert.strictEqual(budget._tag, "ChildSessionBudgetFailure");
    if (budget._tag === "ChildSessionBudgetFailure") {
      assert.strictEqual(budget.maxChildren, 4);
      assert.strictEqual(budget.attemptedChildren, 5);
    }
  });
});

it.each([
  ["Selected model is at capacity. Please try a different model.", true],
  ['529 {"error":{"type":"overloaded_error","message":"Overloaded"}}', true],
  ["API Error: 529", true],
  ["HTTP 503: retry after 30 seconds", true],
  ["HTTP 503: unsupported service", false],
  ["HTTP 429: rate limit", false],
  ["ran out of turns", false],
])("classifies harness refusal %s without retrying task failures", (message, capacity) => {
  const error = harnessFailure(Option.none(), message);
  assert.strictEqual(Schema.is(AgentCapacityError)(error), capacity);
  const report = reportedOutcome(Option.none(), reportText(error));
  assert(Option.isSome(report));
  assert.strictEqual(
    toAttemptFailure(report.value)._tag,
    capacity ? "ProviderCapacityFailure" : "AgentFailure",
  );
  assert.strictEqual(report.value.message, message);
});

it.each([
  ["[usine:provider-capacity]", "AgentCapacityError", "ProviderCapacityFailure"],
  ["[usine:failed]", "AgentResultError", "AgentFailure"],
] as const)(
  "preserves a %s prefix before later blocker and question reports",
  (marker, tag, failure) => {
    const sessionId = Option.some(AgentSessionId.make("child-1"));
    for (const laterMarker of ["[usine:blocked]", "[usine:question]"]) {
      for (const newline of ["\n", "\r\n"]) {
        const message = `Harness refused.${newline}${laterMarker}${newline}Report details.`;
        const report = reportedOutcome(sessionId, ` \n${marker}${newline}${message}\n `);
        assert(Option.isSome(report));
        assert.strictEqual(report.value._tag, tag);
        assert.strictEqual(report.value.message, message);
        assert.deepStrictEqual(report.value.sessionId, sessionId);
        assert.strictEqual(toAttemptFailure(report.value)._tag, failure);
      }
    }
  },
);

it("recognizes [usine:blocked] after narration and preserves the report details", () => {
  for (const prefix of ["", "  ", "The delegation was interrupted.\n", "Narration.\r\n  "]) {
    for (const separator of ["\n", " "]) {
      const report = reportedOutcome(
        Option.none(),
        `${prefix}[usine:blocked]${separator}Cannot finish.\nRemaining work.`,
      );
      assert(Option.isSome(report));
      assert.strictEqual(report.value._tag, "AgentBlockedError");
      assert.strictEqual(report.value.message, "Cannot finish.\nRemaining work.");
    }
  }
  const bare = reportedOutcome(Option.none(), "[usine:blocked]");
  assert(Option.isSome(bare));
  assert.match(bare.value.message, /without details/u);
});

it("does not treat ordinary narration or an embedded harness failure as a reserved report", () => {
  for (const answer of [
    "Finished.",
    "The child was [usine:failed] but recovery completed.",
    "The child was [usine:provider-capacity] but recovery completed.",
    "Published. The earlier [usine:blocked] outcome is resolved.",
    "Answered the earlier [usine:question] and completed the review.",
    "The child ended with **[usine:blocked]** and I resolved it.",
    "The markers ([usine:blocked] and [usine:question]) are reserved.",
    "See the [[usine:blocked]](https://example.com) marker docs.",
    "Published.[usine:blocked] was the earlier outcome, now resolved.",
  ]) {
    assert(Option.isNone(reportedOutcome(Option.none(), answer)));
  }
});

const quotedReports = [
  "The child returned [usine:blocked]\nso I continued.",
  'Reviewed the parser: `reportedOutcome(id, "[usine:blocked]\\nmsg")` stays a mention.',
  "Example report:\n```text\n[usine:blocked]\nPermission denied.\n```\nThe review passed.",
  "Example:\n~~~~\nNarration.[usine:question]\n~~~\n[usine:blocked]\n~~~~\nDone.",
  "Unclosed example:\n```\n[usine:blocked]\nPermission denied.",
  "Example:\n```\nSnippet:\n```bash\n[usine:blocked]\n```\nDone.",
  'The child answered "[usine:blocked]\nNo access." and I continued.',
  'The child answered:\n"[usine:blocked]\nNo access."\nI continued with the fix.',
  'The child answered ("[usine:blocked]\nNo access.") and I continued.',
  "answer=`[usine:blocked]\nNo access.`;",
] as const;

it.each(quotedReports)("treats a quoted marker as ordinary text: %j", (answer) => {
  assert(Option.isNone(reportedOutcome(Option.none(), answer)));
});

it("recognizes a report header after a closed code fence", () => {
  const report = reportedOutcome(
    Option.none(),
    "Example:\n```\n[usine:question]\n```\nThe review is blocked.[usine:blocked]\r\nPermission denied.",
  );
  assert(Option.isSome(report));
  assert.strictEqual(report.value._tag, "AgentBlockedError");
  assert.strictEqual(report.value.message, "Permission denied.");
});

it.each([
  "- Ex:\n\n    ```\n    [usine:question]\n    ```\n[usine:blocked]\nNo access.",
  "Ran ```pnpm test```[usine:blocked]\nNo access.",
  'The command failed with "permission denied"[usine:blocked]\nNo access.',
  'I ran `git commit -m ""`[usine:blocked]\nNo access.',
])("recognizes a report header after an indented fence or inline backticks: %j", (answer) => {
  const report = reportedOutcome(Option.none(), answer);
  assert(Option.isSome(report));
  assert.strictEqual(report.value._tag, "AgentBlockedError");
  assert.strictEqual(report.value.message, "No access.");
});

it("uses the first blocker or question when a final answer includes multiple reports", () => {
  const report = reportedOutcome(
    Option.none(),
    "Narration.\n[usine:blocked] Blocked.\n[usine:question] Which transport?",
  );
  assert(Option.isSome(report));
  assert.strictEqual(report.value._tag, "AgentBlockedError");
  assert.strictEqual(report.value.message, "Blocked.\n[usine:question] Which transport?");
});

it("recognizes a [usine:question] report header appended to narration", () => {
  const report = reportedOutcome(
    Option.none(),
    "The prior delegation was interrupted.[usine:question]\nThe review is incomplete.",
  );
  assert(Option.isSome(report));
  assert.strictEqual(report.value._tag, "AgentQuestionError");
  assert.strictEqual(report.value.message, "The review is incomplete.");
});
