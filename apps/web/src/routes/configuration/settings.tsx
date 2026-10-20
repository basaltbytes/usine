import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "../../configuration/query.ts";
import { SettingsPage } from "../../configuration/settings.tsx";

const Settings = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <SettingsPage configuration={data} />;
};

export const Route = createFileRoute("/configuration/settings")({ component: Settings });
