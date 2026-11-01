import { useCan } from "~/lib/permissions";
import { Upgrades } from "~/features/configuration/components/upgrades";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { upgradeQuery } from "~/features/configuration/queries";
import { configurationQuery } from "~/lib/configuration/queries";
import { SettingsPage } from "~/features/configuration/settings.page";

const Settings = () => {
  const admin = useCan("admin");
  const { data } = useSuspenseQuery(configurationQuery());
  return <SettingsPage configuration={data}>{admin && <Upgrades />}</SettingsPage>;
};

export const Route = createFileRoute("/configuration/settings")({
  loader: ({ context }) => context.queryClient.ensureQueryData(upgradeQuery()),
  component: Settings,
});
