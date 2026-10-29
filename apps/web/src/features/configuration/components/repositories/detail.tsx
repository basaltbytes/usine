import { entityKey } from "~/features/configuration/lib/entities";
import { Link } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { LabelBadge } from "~/components/label-badge";
import { RepositoryMark } from "~/components/repository-mark";
import { LabelStanding } from "~/features/configuration/components/repositories/label-standing";
import { RepositoryFacts } from "~/features/configuration/components/repositories/facts";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Missing,
  Unset,
} from "~/features/configuration/components/section";

type RepositoryDetailProps = {
  readonly owner: string;
  readonly name: string;
  readonly configuration: ConfigurationView;
};

export const RepositoryDetail = ({ owner, name, configuration }: RepositoryDetailProps) => {
  const full = `${owner}/${name}`;
  const repository = configuration.repositories.find(
    (candidate) => candidate.name.toLowerCase() === full.toLowerCase(),
  );
  if (repository === undefined)
    return (
      <ConfigurationPage entity={entityKey("repository", full)} title={full}>
        <Missing title="Repository not registered">
          {full} is not under <code>repos</code> in <code>usine.yaml</code>.{" "}
          <Link to="/configuration/repositories" className="text-primary hover:underline">
            See all repositories
          </Link>
          .
        </Missing>
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage
      entity={entityKey("repository", repository.name)}
      title={repository.name}
      leading={<RepositoryMark repository={repository.name} size="title" />}
    >
      <DetailColumns
        facts={
          <RepositoryFacts
            repository={repository}
            project={configuration.projects.find((project) => project.includes(repository.name))}
          />
        }
      >
        <DetailSection title="Labels usine creates" aside="From labels in usine.yaml">
          {repository.declaredLabels.length === 0 ? (
            <p className="text-muted-foreground">
              No labels under <code>labels</code> in <code>usine.yaml</code>.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {repository.declaredLabels.map((label) => (
                <li key={label.name} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <LabelBadge name={label.name} label={label} />
                  <span className="text-xs">
                    {label.onGitHub === true && label.failure === null ? (
                      <Unset>On GitHub</Unset>
                    ) : (
                      <LabelStanding label={label} />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      </DetailColumns>
    </ConfigurationPage>
  );
};
