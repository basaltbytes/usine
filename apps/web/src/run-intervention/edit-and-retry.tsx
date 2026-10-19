import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentName } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { EditAndRetry as Amendment, type RunView } from "@usine/orchestrator/operator";
import { useId, useState } from "react";
import { api } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ErrorAlert } from "@/components/error-alert";
import { cn } from "@/lib/utils";

/** Edits only the task and roster choice; the server derives persona and brain settings. */
export const EditAndRetry = ({
  run,
  close,
  className,
}: {
  readonly run: RunView;
  readonly close: () => void;
  readonly className?: string;
}) => {
  const [task, setTask] = useState(run.task);
  const [agent, setAgent] = useState<string>(run.agent);
  const id = useId();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: ["agents"],
    queryFn: () => api((client) => client.agents()),
  });
  const mutation = useMutation({
    mutationFn: () =>
      api((client) =>
        client.editAndRetry({
          params: { runId: run.id },
          payload: new Amendment({ task: AttemptTask.make(task), agent: AgentName.make(agent) }),
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", run.id] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      close();
    },
  });
  return (
    <form
      aria-label="Edit and retry"
      className={cn("space-y-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !mutation.isPending &&
          task.trim().length > 0 &&
          roster.data?.some((name) => name === agent)
        )
          mutation.mutate();
      }}
    >
      <h3 className="text-md font-semibold">Edit and retry</h3>
      <p className="text-xs text-muted-foreground">
        Later attempts use this task and agent until you edit them again.
      </p>
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
        <Button
          type="submit"
          size="sm"
          disabled={
            mutation.isPending ||
            task.trim().length === 0 ||
            !roster.data?.some((name) => name === agent)
          }
        >
          Save and retry
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
      {roster.isError && <ErrorAlert message={roster.error.message} />}
      {mutation.isError && <ErrorAlert message={mutation.error.message} />}
    </form>
  );
};
