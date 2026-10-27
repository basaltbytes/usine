import { ArrowClockwiseIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InstanceReload } from "@usine/orchestrator/current-instance";
import { ErrorAlert } from "~/components/error-alert";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { reloadSummary } from "~/lib/configuration/strings";

export type ConfigurationReload = UseMutationResult<InstanceReload, Error, void>;

/** Reloads the instance folder; the configuration query is invalidated even if the reload is rejected, because Worker preflights can still change. */
export const useReloadConfiguration = (): ConfigurationReload => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api((client) => client.reload()),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({ queryKey: ["run"] }),
      ]),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["configuration"] }),
  });
};

type ReloadConfigurationButtonProps = { readonly reload: ConfigurationReload };

export const ReloadConfigurationButton = ({ reload }: ReloadConfigurationButtonProps) => (
  <Button variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>
    <ArrowClockwiseIcon data-icon="inline-start" aria-hidden="true" />
    {reload.isPending ? "Reloading…" : "Reload configuration"}
  </Button>
);

type ReloadOutcomeProps = { readonly reload: ConfigurationReload };

/** Renders the changes from the last reload, or the reason it was rejected; renders nothing before the first reload. */
export const ReloadOutcome = ({ reload }: ReloadOutcomeProps) => {
  if (reload.isError)
    return <ErrorAlert title="Configuration not reloaded" message={reload.error.message} />;
  if (!reload.isSuccess) return null;
  return (
    <Alert>
      <CheckCircleIcon weight="fill" className="text-run-succeeded" />
      <AlertTitle>Configuration reloaded</AlertTitle>
      <AlertDescription>
        <ul>
          {reloadSummary(reload.data).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-1">Applies to new runs; open runs are unchanged</p>
      </AlertDescription>
    </Alert>
  );
};
