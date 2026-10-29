import { Link } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { RepositoryMark } from "~/components/repository-mark";
import { ConfigurationPage, Missing } from "~/features/configuration/components/section";
import { projectCopy } from "~/features/configuration/strings";

type ProjectsListProps = { readonly configuration: ConfigurationView };
export const ProjectsList = ({ configuration }: ProjectsListProps) => (
  <ConfigurationPage title={projectCopy.title} createKind="project">
    {configuration.projects.length === 0 ? (
      <Missing title={projectCopy.empty}>{null}</Missing>
    ) : (
      <ul className="divide-y">
        {configuration.projects.map((project) => (
          <li key={project.id} className="min-w-0 py-3">
            <Link
              to="/configuration/projects/$project"
              params={{ project: project.id }}
              className="font-medium text-primary hover:underline"
            >
              {project.name}
            </Link>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {project.repositories.map((repository) => (
                <li key={repository} className="flex min-w-0 items-center gap-1.5">
                  <RepositoryMark repository={repository} />
                  <span className="wrap-anywhere">{repository}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    )}
  </ConfigurationPage>
);
