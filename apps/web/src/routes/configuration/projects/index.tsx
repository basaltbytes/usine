import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/lib/configuration/queries";
import { ProjectsList } from "~/features/configuration/components/projects/list";

const Projects = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <ProjectsList configuration={data} />;
};
export const Route = createFileRoute("/configuration/projects/")({ component: Projects });
