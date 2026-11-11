import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LabelsList } from "~/features/configuration/components/labels/list";
import { configurationQuery } from "~/lib/configuration/queries";

const Labels = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <LabelsList configuration={data} />;
};

export const Route = createFileRoute("/configuration/labels/")({ component: Labels });
