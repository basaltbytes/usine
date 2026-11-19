import type { AccessScope } from "@usine/core/access";
import type { CycleBudgetAskId } from "@usine/core/cycle-budget";
import type { LoopName } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { Data } from "effect";

/** What an operator call acts on, which decides the scope its permission is checked on. */
export type CallScopeTarget = Data.TaggedEnum<{
  Run: { readonly runId: RunId };
  Repository: { readonly repository: RepositoryName };
  /** A project-qualified loop name, or a short name while it is unique. */
  Loop: { readonly loop: LoopName };
  CycleBudgetAsk: { readonly askId: CycleBudgetAskId };
}>;
export const CallScopeTarget = Data.taggedEnum<CallScopeTarget>();

/** A call's target as the operation will resolve it, such as a project-qualified loop, and its scope. */
export interface ResolvedCall {
  readonly target: CallScopeTarget;
  readonly scope: AccessScope;
}
