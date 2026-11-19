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
