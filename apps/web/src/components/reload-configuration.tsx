import { ArrowClockwiseIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InstanceReload } from "@usine/orchestrator/current-instance";
import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import { reloadSummary } from "../operator-copy.ts";

export type ConfigurationReload = UseMutationResult<InstanceReload, Error, void>;

/** Loads the instance folder again, then refreshes the overview, the Agent roster, and the
 * configuration, whose Worker preflights a refused reload can change too. */
export const useReloadConfiguration = (): ConfigurationReload => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api((client) => client.reload()),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["configuration"] }),
  });
};

export const ReloadConfigurationButton = ({ reload }: { readonly reload: ConfigurationReload }) => (
  <Button variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>
    <ArrowClockwiseIcon data-icon="inline-start" aria-hidden="true" />
    {reload.isPending ? "Reloading…" : "Reload configuration"}
  </Button>
);

/** What the last reload changed, or why it was refused; nothing before the first reload. */
export const ReloadOutcome = ({ reload }: { readonly reload: ConfigurationReload }) => {
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
        <p className="mt-1">New Runs use it; open Runs keep the Agent they were opened with.</p>
      </AlertDescription>
    </Alert>
  );
};
