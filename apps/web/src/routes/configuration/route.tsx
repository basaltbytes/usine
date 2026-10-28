import { createFileRoute } from "@tanstack/react-router";
import {
  ConfigurationPending,
  ConfigurationSection,
  ConfigurationUnavailable,
} from "~/features/configuration/configuration.page";
import { configurationQuery } from "~/lib/configuration/queries";

export const Route = createFileRoute("/configuration")({
  loader: ({ context }) => context.queryClient.ensureQueryData(configurationQuery()),
  pendingComponent: ConfigurationPending,
  errorComponent: ConfigurationUnavailable,
  component: ConfigurationSection,
});
