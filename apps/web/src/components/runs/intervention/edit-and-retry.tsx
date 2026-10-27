import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentName } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { EditAndRetry as Amendment, type RunView } from "@usine/orchestrator/operator";
import { useId, useState } from "react";
import { api } from "~/lib/api";
import { runAgainBlocked } from "~/lib/strings";
import { useRunAgain } from "~/hooks/runs/actions";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { ErrorAlert } from "~/components/error-alert";
import { cn } from "~/lib/utils";

/** The target of an edit: the failed Run's next Attempt, or a new Run of a closed Run. */
export type EditIntent = "retry" | "runAgain";

const editCopy = {
  retry: {
    title: "Edit and retry",
    note: "Later attempts use this task and agent until you edit them again.",
    submit: "Save and retry",
  },
  runAgain: {
    title: "Edit and run again",
    note: "Opens a new run on this item with this task and agent. This run is unchanged.",
    submit: "Save and run again",
  },
} as const satisfies Record<EditIntent, { title: string; note: string; submit: string }>;

/** Returns whether the Run still allows `intent`. */
export const editApplies = (run: RunView, intent: EditIntent): boolean =>
  intent === "retry" ? run.canRetry : run.canRunAgain;

const useRetryWith = (run: RunView, close: () => void) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (amendment: Amendment) =>
      api((client) => client.editAndRetry({ params: { runId: run.id }, payload: amendment })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", run.id] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      close();
    },
  });
};

/** Renders an editor for the task and Agent choice. For a run again, calls `openRun` with the new Run. */
export const EditAndRetry = ({
  run,
  intent,
  close,
  openRun,
  className,
}: {
  readonly run: RunView;
  readonly intent: EditIntent;
  readonly close: () => void;
  /** Opens the Run that Run again created. */
  readonly openRun: (runId: RunId) => void;
  readonly className?: string;
}) => {
  const [task, setTask] = useState(run.task);
  const [agent, setAgent] = useState<string>(run.agent);
  const id = useId();
  const copy = editCopy[intent];
  const roster = useQuery({
    queryKey: ["agents"],
    queryFn: () => api((client) => client.agents()),
  });
  const retry = useRetryWith(run, close);
  const again = useRunAgain();
  const mutation = intent === "retry" ? retry : again;
  const valid = task.trim().length > 0 && roster.data?.some((name) => name === agent) === true;
  const submit = () => {
    const amendment = new Amendment({ task: AttemptTask.make(task), agent: AgentName.make(agent) });
    if (intent === "retry") retry.mutate(amendment);
    else
      again.mutate(
        { runId: run.id, amendment },
        {
          onSuccess: (result) => {
            if (result._tag === "Claimed") openRun(result.runId);
          },
        },
      );
  };
  return (
    <form
      aria-label={copy.title}
      className={cn("space-y-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!mutation.isPending && valid) submit();
      }}
    >
      <h3 className="text-md font-semibold">{copy.title}</h3>
      <p className="text-xs text-muted-foreground">{copy.note}</p>
      <Label htmlFor={`${id}-task`}>Task</Label>
      <Textarea
        id={`${id}-task`}
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={7}
        disabled={mutation.isPending}
      />
      <Label htmlFor={`${id}-agent`}>Agent</Label>
      <NativeSelect
        id={`${id}-agent`}
        value={agent}
        onChange={(event) => setAgent(event.target.value)}
        disabled={mutation.isPending || roster.isPending}
      >
        {!roster.data?.includes(run.agent) && (
          <NativeSelectOption value={run.agent} disabled>
            {run.agent} · unavailable
          </NativeSelectOption>
        )}
        {roster.data?.map((name) => (
          <NativeSelectOption key={name} value={name}>
            {name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending || !valid}>
          {copy.submit}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={close}
        >
          Close editor
        </Button>
      </div>
      {again.data?._tag === "CycleBlocked" && (
        <p role="status" className="text-xs text-needs-you">
          {runAgainBlocked}
        </p>
      )}
      {roster.isError && <ErrorAlert message={roster.error.message} />}
      {mutation.isError && <ErrorAlert message={mutation.error.message} />}
    </form>
  );
};
