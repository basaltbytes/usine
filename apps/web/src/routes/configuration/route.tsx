import { createFileRoute } from "@tanstack/react-router";
import {
  ConfigurationPending,
  ConfigurationSection,
  ConfigurationUnavailable,
} from "../../configuration/layout.tsx";
import { configurationQuery } from "../../configuration/query.ts";

export const Route = createFileRoute("/configuration")({
  loader: ({ context }) => context.queryClient.ensureQueryData(configurationQuery()),
  pendingComponent: ConfigurationPending,
  errorComponent: ConfigurationUnavailable,
  component: ConfigurationSection,
});
