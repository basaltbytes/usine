import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttemptId } from "@usine/core/attempt";
import {
  Interrupt,
  OperatorMessage,
  Release,
  type OperatorAction,
  type SessionTarget,
} from "@usine/core/attempt/channel";
import type { RunId } from "@usine/core/run";
import { SessionIntervention } from "@usine/orchestrator/operator";
import { useId, useState } from "react";
import { runDetailKey } from "~/lib/runs/queries";
import { api } from "~/lib/api";
import { CommandButton } from "~/components/command-palette/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { ErrorAlert } from "~/components/error-alert";

type SessionComposerProps = {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly target: SessionTarget;
  readonly paused: boolean;
  readonly held: boolean;
};

export const SessionComposer = ({
  runId,
  attemptId,
  target,
  paused,
  held,
}: SessionComposerProps) => {
  const [message, setMessage] = useState("");
  const id = useId();
  const queryClient = useQueryClient();
  const child = target._tag === "Child";
  const releasable = child || paused || held;
  const mutation = useMutation({
    mutationFn: (action: OperatorAction) =>
      api((client) =>
        client.intervene({
          params: { runId },
          payload: new SessionIntervention({ attemptId, target, action }),
        }),
      ),
    onSuccess: async (_result, action) => {
      if (action._tag === "OperatorMessage")
        setMessage((current) => (current === action.message ? "" : current));
      await queryClient.invalidateQueries({ queryKey: runDetailKey(runId) });
    },
  });
  const send = () => {
    if (message.trim().length > 0 && !mutation.isPending)
      mutation.mutate(new OperatorMessage({ message }));
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{child ? "Message this child" : "Message the parent"}</Label>
      <Textarea
        id={id}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        rows={3}
        placeholder={paused ? "Send guidance to resume" : "Add guidance or ask a question"}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <CommandButton
          command={paused ? "Send and resume" : "Send"}
          size="sm"
          onClick={send}
          disabled={mutation.isPending || message.trim().length === 0}
        >
          {paused ? "Send and resume" : "Send"}
        </CommandButton>
        <CommandButton
          command={"Pause session"}
          size="sm"
          variant="outline"
          disabled={mutation.isPending || paused}
          onClick={() => mutation.mutate(new Interrupt())}
        >
          Pause session
        </CommandButton>
        {releasable && (
          <CommandButton
            command={child ? "Release child" : "Release parent"}
            size="sm"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(new Release())}
          >
            {child ? "Release child" : "Release parent"}
          </CommandButton>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {child
          ? "A message places a hold. Release the child to return the result to the parent"
          : "A message places a hold. Release the parent to continue the task"}
      </p>
      {mutation.isError && <ErrorAlert message={mutation.error.message} />}
    </div>
  );
};
