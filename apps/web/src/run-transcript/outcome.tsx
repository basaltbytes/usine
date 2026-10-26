import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import type { FailureView } from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { Markdown } from "@/components/markdown";
import { StateMark } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { failureMessage, failureReason } from "../operator-copy.ts";
import type { AttemptEnd } from "./document/model.ts";

const FailureNote = ({
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

export const SalvageLine = ({ salvage }: { readonly salvage: AttemptSalvage | null }) => (
  <p className="text-xs text-muted-foreground wrap-anywhere">
    {salvage === null
      ? "No salvage branch"
      : Match.valueTags(salvage, {
          Pushed: ({ ref, commit }) => (
            <>
              Unfinished work pushed to <span className="font-mono">{ref}</span> at{" "}
              <span className="font-mono">{commit.slice(0, 7)}</span>
            </>
          ),
          Retained: ({ path, message }) => (
            <>
              Salvage incomplete: unfinished work at <span className="font-mono">{path}</span>,
              retried at each startup while the worker is configured. Last error: {message}
            </>
          ),
          Rejected: ({ path, message }) => (
            <>
              Salvage rejected: unfinished work at <span className="font-mono">{path}</span>. The
              remote refused its push, so startup doesn't retry it until its commit changes. Error:{" "}
              {message}
            </>
          ),
        })}
  </p>
);

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
