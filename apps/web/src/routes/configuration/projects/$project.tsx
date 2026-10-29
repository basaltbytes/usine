import { createFileRoute } from "@tanstack/react-router";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { entityKey } from "~/features/configuration/lib/entities";

const Project = () => {
  const { project } = Route.useParams();
  return (
    <ConfigurationPage title={project} entity={entityKey("project", project)}>
      {null}
    </ConfigurationPage>
  );
};

export const Route = createFileRoute("/configuration/projects/$project")({ component: Project });
