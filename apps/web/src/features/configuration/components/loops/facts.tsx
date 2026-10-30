import { Link } from "@tanstack/react-router";
import type { ConfigurationView, LoopFileView } from "@usine/orchestrator/operator";
import { RepositoryLink } from "~/features/configuration/components/loops/repository-link";
import { Fact, Facts, Unset } from "~/features/configuration/components/section";
import { approvalLabel, permissionsLabel } from "~/features/configuration/strings";
import { brainLine } from "~/lib/strings";

type LoopFactsProps = {
  readonly loop: LoopFileView;
  readonly configuration: ConfigurationView;
};

export const LoopFacts = ({ loop, configuration }: LoopFactsProps) => {
  const project = configuration.projects.find((project) => loop.name.startsWith(`${project.id}/`));
  const agent = configuration.agents.find(({ name }) => name === loop.agent);
  return (
    <Facts>
      {project !== undefined && (
        <Fact label="Project">
          <Link
            to="/configuration/projects/$project"
            params={{ project: project.id }}
            className="text-primary hover:underline"
          >
            {project.name}
          </Link>
        </Fact>
      )}
      <Fact label="Agent">
        <Link
          to="/configuration/agents/$agent"
          params={{ agent: loop.agent }}
          className="text-primary hover:underline"
        >
          {loop.agent}
        </Link>
        {agent !== undefined && (
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{brainLine(agent)}</p>
        )}
      </Fact>
      <Fact label="Repositories">
        {loop.repositories.length === 0 ? (
          <Unset>No registered repository matches the selector</Unset>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {loop.repositories.map((repository) => (
              <li key={repository}>
                <RepositoryLink repository={repository} />
              </li>
            ))}
          </ul>
        )}
      </Fact>
      <Fact label="Approval">
        {approvalLabel(loop.approval)}
        {loop.approval !== "none" && loop.approval !== "required" && (
          <code className="block text-xs wrap-anywhere">{loop.approval}</code>
        )}
      </Fact>
      <Fact label="Max cycles">
        <span className="tabular-nums">{loop.maxCycles}</span>{" "}
        <Unset>runs per item before a reset</Unset>
      </Fact>
      <Fact label="Permissions">{permissionsLabel[loop.permissions]}</Fact>
      <Fact label="Priority">
        {loop.priority === null ? (
          <Unset>0; ties use lane order</Unset>
        ) : (
          <>
            <span className="tabular-nums">{loop.priority}</span>{" "}
            <Unset>higher values go first; ties use lane order</Unset>
          </>
        )}
      </Fact>
      <Fact label="Step">
        <code className="font-mono text-xs">{loop.step}</code>
      </Fact>
    </Facts>
  );
};
