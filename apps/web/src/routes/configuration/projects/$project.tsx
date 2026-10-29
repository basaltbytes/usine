import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/lib/configuration/queries";
import { ProjectDetail } from "~/features/configuration/components/projects/detail";

const Project = () => {
  const { project } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <ProjectDetail id={project} configuration={data} />;
};
export const Route = createFileRoute("/configuration/projects/$project")({ component: Project });
