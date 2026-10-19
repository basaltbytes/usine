import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import type { FailureView } from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { Markdown } from "@/components/markdown";
import { StateMark } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { failureMessage, failureReason } from "../operator-copy.ts";
import type { AttemptEnd } from "./document/model.ts";

/** A failed Attempt's typed reason and message on a red tint. */
export const FailureNote = ({
  failure,
  className,
}: {
  readonly failure: FailureView;
  readonly className?: string;
}) => (
  <div
    className={cn(
      "rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 text-sm",
      className,
    )}
  >
    <p className="font-medium text-destructive">{failureReason(failure)}</p>
    <Markdown className="wrap-anywhere">{failureMessage(failure)}</Markdown>
  </div>
);

/** Where a failed or canceled Attempt's unfinished work went. */
export const SalvageLine = ({ salvage }: { readonly salvage: AttemptSalvage | null }) => (
  <p className="text-xs text-muted-foreground wrap-anywhere">
    {salvage === null
      ? "No salvage branch."
      : Match.valueTags(salvage, {
          Pushed: ({ ref, commit }) => (
            <>
              Unfinished work pushed to <span className="font-mono">{ref}</span> at{" "}
              <span className="font-mono">{commit.slice(0, 7)}</span>; a retry resumes from it.
            </>
          ),
          Retained: ({ path, message }) => (
            <>
              Salvage incomplete; unfinished work stays at{" "}
              <span className="font-mono">{path}</span> and is retried at every startup while its
              Worker is configured. Last error: {message}
            </>
          ),
        })}
  </p>
);

/** How an Attempt ended: the failure note and salvage, the result, or the cancellation. */
export const Outcome = ({ end }: { readonly end: AttemptEnd }) =>
  Match.valueTags(end, {
    Failed: ({ failure, salvage }) => (
      <div className="space-y-2">
        <FailureNote failure={failure} />
        <SalvageLine salvage={salvage} />
      </div>
    ),
    Succeeded: ({ message }) => (
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <StateMark state="Succeeded" />
          Succeeded
        </p>
        {Option.match(message, {
          onNone: () => null,
          onSome: (text) => <Markdown className="text-md wrap-anywhere">{text}</Markdown>,
        })}
      </div>
    ),
    Canceled: ({ salvage }) => (
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <StateMark state="Canceled" />
          Canceled
        </p>
        <SalvageLine salvage={salvage} />
      </div>
    ),
  });
