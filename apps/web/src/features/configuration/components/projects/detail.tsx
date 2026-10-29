import { Link } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import {
  ConfigurationPage,
  DetailSection,
  Missing,
} from "~/features/configuration/components/section";
import { RepositoryLink } from "~/features/configuration/components/loops/repository-link";
import { entityKey } from "~/features/configuration/lib/entities";
import { projectCopy } from "~/features/configuration/strings";

type ProjectDetailProps = { readonly id: string; readonly configuration: ConfigurationView };
export const ProjectDetail = ({ id, configuration }: ProjectDetailProps) => {
  const project = configuration.projects.find((project) => project.id === id);
  return (
    <ConfigurationPage title={project?.name ?? id} entity={entityKey("project", id)}>
      {project === undefined ? (
        <Missing title={projectCopy.missing}>{null}</Missing>
      ) : (
        <>
          <Link
            to="/projects/$project"
            params={{ project: id }}
            className="text-primary hover:underline"
          >
            {projectCopy.board}
          </Link>
          <DetailSection title={projectCopy.repositories}>
            <ol className="space-y-2">
              {project.repositories.map((repository) => (
                <li key={repository}>
                  <RepositoryLink repository={repository} />
                </li>
              ))}
            </ol>
          </DetailSection>
          <DetailSection title={projectCopy.lanes}>
            <ol className="space-y-2">
              {project.lanes.map((lane) => (
                <li key={lane.name} className="flex flex-wrap gap-2">
                  <span>{lane.name}</span>
                  <span className="text-muted-foreground">
                    {lane.sources
                      .map((source) => ("label" in source ? source.label : source.state))
                      .join(", ")}
                  </span>
                </li>
              ))}
            </ol>
          </DetailSection>
        </>
      )}
    </ConfigurationPage>
  );
};
