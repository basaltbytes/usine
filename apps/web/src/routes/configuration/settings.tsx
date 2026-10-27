import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/features/configuration/queries";
import { SettingsPage } from "~/features/configuration/settings.page";

const Settings = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <SettingsPage configuration={data} />;
};

export const Route = createFileRoute("/configuration/settings")({ component: Settings });
