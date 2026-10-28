import { TerminalWindowIcon } from "@phosphor-icons/react";
import type { AttemptView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { SessionHandoff } from "~/components/runs/transcript/handoff";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { sessionName } from "~/features/runs/lib/outline";
import type { TranscriptSession } from "~/lib/runs/transcript/model";

type ResumeDetailsProps = {
  readonly session: TranscriptSession;
  readonly attempt: AttemptView;
};

export const ResumeDetails = ({ session, attempt }: ResumeDetailsProps) => {
  const identity = session.session;
  if (
    identity._tag === "ChildSession" &&
    identity.brain.harness === "codex" &&
    Option.isSome(identity.gatewayCredential)
  )
    return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Resume details for ${sessionName(session)}`}
            title="Resume details"
            className="text-muted-foreground"
          />
        }
      >
        <TerminalWindowIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-[28rem] max-w-[calc(100vw-2rem)] p-3 shadow-raised"
      >
        <SessionHandoff session={session} attempt={attempt} />
      </PopoverContent>
    </Popover>
  );
};
