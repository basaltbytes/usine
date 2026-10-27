import type { AttemptId } from "@usine/core/attempt";
import type { RunView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { runActionLabel } from "~/lib/strings";

/** An operator action on a Run; resolving a failure includes the failed Attempt. */
export type RunAction =
  | { readonly _tag: "Approve" }
  | { readonly _tag: "Retry" }
  | { readonly _tag: "EditRetry" }
  | { readonly _tag: "RunAgain" }
  | { readonly _tag: "EditRunAgain" }
  | { readonly _tag: "Resolve"; readonly attemptId: AttemptId; readonly question: boolean }
  | { readonly _tag: "Cancel" };

/** The Run's allowed actions by prominence: one primary button, one secondary button, and a menu. */
export interface ActionPlan {
  readonly primary: RunAction | null;
  readonly secondary: RunAction | null;
  readonly more: ReadonlyArray<RunAction>;
}

type Tag = RunAction["_tag"];

export const actionLabel = (action: RunAction): string =>
  Match.valueTags(action, {
    Approve: () => runActionLabel.approve,
    Retry: () => runActionLabel.retry,
    EditRetry: () => "Edit and retry",
    RunAgain: () => runActionLabel.runAgain,
    EditRunAgain: () => "Edit and run again",
    Resolve: ({ question }) => (question ? "Mark answered" : "Mark resolved"),
    Cancel: () => runActionLabel.cancel,
  });

/** Returns the Run's actions that its `can*` flags allow, placed by the Run state and the latest failure. */
export const actionPlan = (
  run: Pick<
    RunView,
    | "state"
    | "attempts"
    | "canApprove"
    | "canRetry"
    | "canRunAgain"
    | "canCancel"
    | "canResolveFailure"
  >,
): ActionPlan => {
  const latest = run.attempts.at(-1);
  const failure = latest?.outcome?._tag === "Failed" ? latest.outcome.failure._tag : null;
  const allowed: ReadonlyArray<RunAction> = [
    ...(run.canApprove ? [{ _tag: "Approve" } as const] : []),
    ...(run.canRetry ? [{ _tag: "Retry" } as const, { _tag: "EditRetry" } as const] : []),
    ...(run.canRunAgain ? [{ _tag: "RunAgain" } as const, { _tag: "EditRunAgain" } as const] : []),
    ...(run.canResolveFailure && latest !== undefined
      ? [
          {
            _tag: "Resolve",
            attemptId: latest.id,
            question: failure === "QuestionFailure",
          } as const,
        ]
      : []),
    ...(run.canCancel ? [{ _tag: "Cancel" } as const] : []),
  ];
  const pick = (tags: ReadonlyArray<Tag>) =>
    tags.flatMap((tag) => allowed.filter((action) => action._tag === tag));
  const placed = ((): ActionPlan => {
    if (run.canApprove) {
      const [primary = null] = pick(["Approve"]);
      return { primary, secondary: null, more: pick(["Cancel"]) };
    }
    if (run.state === "Failed") {
      const answering =
        run.canResolveFailure && (failure === "QuestionFailure" || failure === "BlockedFailure");
      const [primary = null, secondary = null, ...more] = pick(
        answering ? ["Resolve", "EditRetry", "Retry"] : ["Retry", "EditRetry", "Resolve"],
      );
      return { primary, secondary, more };
    }
    const [secondary = null, ...more] = pick(
      run.canRunAgain ? ["RunAgain", "EditRunAgain"] : ["Cancel"],
    );
    return { primary: null, secondary, more };
  })();
  const used = new Set([placed.primary, placed.secondary, ...placed.more]);
  return { ...placed, more: [...placed.more, ...allowed.filter((action) => !used.has(action))] };
};
