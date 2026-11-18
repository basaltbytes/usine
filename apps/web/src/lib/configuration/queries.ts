import { changes } from "~/lib/query-changes";
import { queryOptions } from "@tanstack/react-query";
import { ConfigurationView } from "@usine/orchestrator/operator";
import { Effect, Schema } from "effect";
import { api } from "~/lib/api";

export const configurationQuery = () =>
  queryOptions({
    queryKey: ["configuration"] as const,
    queryFn: () =>
      api(
        (client) =>
          client
            .configuration()
            .pipe(
              Effect.filterOrElse(Schema.is(ConfigurationView), () =>
                Effect.die(
                  "The server returned a configuration summary instead of the configuration.",
                ),
              ),
            ),
        "full",
      ),
    meta: { refreshLabel: "Configuration", changes: changes.kind("configuration", "worker") },
    staleTime: 60_000,
  });

export const agentsQuery = () =>
  queryOptions({
    queryKey: ["agents"] as const,
    staleTime: 60_000,
    meta: { refreshLabel: "Agents", changes: changes.kind("configuration") },
    queryFn: () => api((client) => client.agents()),
  });
