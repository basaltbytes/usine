import type { RepositoryName } from "@usine/core/repository";
import {
  ConfigurationEntity,
  type ConfigurationEntityKey,
  type ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import { formatConfigurationEntity } from "@usine/config/folder-codec";
import {
  type ConfigurationReplacement,
  type LoopDraft,
  LoopPreviewRequest,
  ConfigurationWrite,
} from "@usine/orchestrator/operator/http";
import { Effect } from "effect";
import { agentsQuery } from "~/lib/configuration/queries";
import { deskQuery } from "~/lib/desk/queries";
import { runDetailKeys } from "~/lib/runs/queries";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { api } from "~/lib/api";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery } from "~/lib/overview";

const UPGRADE_REFRESH_MS = 5_000;

export const usePauseLoop = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ loop, paused }: { readonly loop: LoopName; readonly paused: boolean }) =>
      api((client) => client[paused ? "unpause" : "pause"]({ params: { loop } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: configurationQuery().queryKey }),
        queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey }),
      ]),
  });
};

export const upgradeQuery = () =>
  queryOptions({
    queryKey: ["upgrade"] as const,
    queryFn: () => api((client) => client.upgradeStatus({})),
    meta: { refreshLabel: "Upgrades" },
    refetchInterval: UPGRADE_REFRESH_MS,
    retry: 3,
  });

const configurationEditorKeys = ["configuration-editor"] as const;

export const entityQuery = (key: ConfigurationEntityKey) =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "entity", key.kind, key.identifier],
    queryFn: () => api((client) => client.configurationEntity({ params: key })),
  });

export const revisionsQuery = (key?: ConfigurationEntityKey) =>
  infiniteQueryOptions({
    queryKey: [...configurationEditorKeys, "history", key?.kind, key?.identifier],
    initialPageParam: undefined,
    queryFn: ({ pageParam }: { readonly pageParam: ConfigurationRevisionNumber | undefined }) =>
      api((client) =>
        client.configurationRevisions({
          query:
            pageParam === undefined
              ? { ...key, limit: 50 }
              : { ...key, before: pageParam, limit: 50 },
        }),
      ),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

export const revisionQuery = (number: ConfigurationRevisionNumber) =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "revision", number],
    queryFn: async () => {
      const revision = await api((client) => client.configurationRevision({ params: { number } }));
      const changes = await Promise.all(
        revision.changes.map(async (change) => ({
          ...change,
          beforeText:
            change.before === null
              ? ""
              : await Effect.runPromise(
                  formatConfigurationEntity(
                    new ConfigurationEntity({ key: change.key, value: change.before }),
                  ),
                ),
          afterText:
            change.after === null
              ? ""
              : await Effect.runPromise(
                  formatConfigurationEntity(
                    new ConfigurationEntity({ key: change.key, value: change.after }),
                  ),
                ),
        })),
      );
      return { ...revision, changes };
    },
  });

type ConfigurationAction =
  | {
      readonly action: "save";
      readonly key: ConfigurationEntityKey;
      readonly payload: ConfigurationReplacement;
    }
  | {
      readonly action: "delete";
      readonly key: ConfigurationEntityKey;
      readonly payload: ConfigurationWrite;
    }
  | {
      readonly action: "revert";
      readonly number: ConfigurationRevisionNumber;
      readonly payload: ConfigurationWrite;
    };

export const useConfigurationWrite = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ConfigurationAction) => {
      switch (request.action) {
        case "save":
          return api((client) =>
            client.replaceConfigurationEntity({ params: request.key, payload: request.payload }),
          );
        case "delete":
          return api((client) =>
            client.deleteConfigurationEntity({
              params: request.key,
              payload: new ConfigurationWrite(request.payload),
            }),
          );
        case "revert":
          return api((client) =>
            client.revertConfigurationRevision({
              params: { number: request.number },
              payload: new ConfigurationWrite(request.payload),
            }),
          );
      }
    },
    onSuccess: () =>
      Promise.all(
        [
          configurationEditorKeys,
          configurationQuery().queryKey,
          overviewQuery().queryKey,
          agentsQuery().queryKey,
          deskQuery().queryKey,
          runDetailKeys,
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
    onError: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: configurationQuery().queryKey }),
        client.invalidateQueries({ queryKey: configurationEditorKeys }),
      ]),
  });
};

export const capabilitiesQuery = () =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "capabilities"],
    queryFn: () => api((client) => client.configurationCapabilities({})),
    staleTime: Infinity,
  });

export const installationRepositoriesQuery = () =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "installation-repositories"],
    queryFn: () => api((client) => client.configurationRepositories({})),
  });

export const repositoryLabelsQuery = (repository: RepositoryName) =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "labels", repository],
    queryFn: () => api((client) => client.configurationLabels({ params: { repository } })),
  });

export const loopCheckQuery = (draft: LoopDraft) =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "loop-check", draft],
    queryFn: () => api((client) => client.checkLoop({ payload: draft })),
    retry: false,
  });

export const loopPreviewQuery = (draft: LoopPreviewRequest) =>
  queryOptions({
    queryKey: [...configurationEditorKeys, "loop-preview", draft],
    queryFn: () => api((client) => client.previewLoop({ payload: draft })),
    retry: false,
    staleTime: 0,
  });
