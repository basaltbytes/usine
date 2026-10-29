import type { Project } from "@usine/config/project";
import { projectCopy } from "~/features/configuration/strings";
import { Link } from "@tanstack/react-router";
import type { RepositoryConfigurationView } from "@usine/orchestrator/operator";
import { Fact, Facts, Unset } from "~/features/configuration/components/section";

type RepositoryFactsProps = {
  readonly repository: RepositoryConfigurationView;
  readonly project: Project | undefined;
};

export const RepositoryFacts = ({ repository, project }: RepositoryFactsProps) => (
  <Facts>
    <Fact label={projectCopy.project}>
      {project === undefined ? (
        <Unset>{projectCopy.unassignedProject}</Unset>
      ) : (
        <Link
          to="/configuration/projects/$project"
          params={{ project: project.id }}
          className="text-primary hover:underline"
        >
          {project.name}
        </Link>
      )}
    </Fact>
    {project !== undefined && (
      <Fact label="Board">
        <Link
          to="/projects/$project"
          params={{ project: project.id }}
          className="text-primary hover:underline"
        >
          {projectCopy.board}
        </Link>
      </Fact>
    )}
    <Fact label="Tags">
      {repository.tags.length === 0 ? <Unset>None</Unset> : repository.tags.join(", ")}
    </Fact>
    <Fact label="Loops">
      {repository.loops.length === 0 ? (
        <Unset>Not selected by any loop</Unset>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {repository.loops.map((loop) => (
            <li key={loop}>
              <Link
                to="/configuration/loops/$loop"
                params={{ loop }}
                className="text-primary hover:underline"
              >
                {loop}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Fact>
  </Facts>
);
