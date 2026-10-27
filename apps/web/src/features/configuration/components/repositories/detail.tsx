import { Link } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { LabelBadge } from "~/components/label-badge";
import { RepositoryMark } from "~/components/repository-mark";
import { LabelStanding } from "~/features/configuration/components/repositories/label-standing";
import { LanesTable } from "~/features/configuration/components/repositories/lanes";
import { laneLabels } from "~/features/configuration/lib/repositories";
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
      <ConfigurationPage title={full}>
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
      title={repository.name}
      leading={<RepositoryMark repository={repository.name} size="title" />}
    >
      <DetailColumns facts={<RepositoryFacts repository={repository} />}>
        <DetailSection
          title="Lanes"
          aside={
            repository.lanes.length === 0 ? undefined : "In board order, as listed in repos[].lanes"
          }
        >
          {[...repository.declaredLabels, ...laneLabels(repository)].some(
            ({ onGitHub }) => onGitHub === null,
          ) && (
            <p className="text-muted-foreground">
              Labels not polled yet. Whether each label is on GitHub shows after the first poll.
            </p>
          )}
          {repository.lanes.length === 0 ? (
            <p className="max-w-[72ch] text-muted-foreground">
              <code>usine.yaml</code> has no lanes for this repository. The board shows lanes
              proposed from the repository labels, and cards cannot be moved. To move cards, add
              lanes under <code>repos[].lanes</code>.
            </p>
          ) : (
            <LanesTable repository={repository} />
          )}
        </DetailSection>
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
