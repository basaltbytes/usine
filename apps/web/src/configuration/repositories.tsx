import { Link, useNavigate } from "@tanstack/react-router";
import { splitRepositoryName } from "@usine/core/repository";
import type {
  ConfigurationView,
  LabelStateView,
  LaneSourceView,
  RepositoryConfigurationView,
} from "@usine/orchestrator/operator";
import { FillCell } from "@/components/fill-cell";
import { LabelBadge } from "@/components/label-badge";
import { RepositoryMark } from "@/components/repository-mark";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { projectParams } from "../overview.ts";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Fact,
  Facts,
  Missing,
  OpeningRow,
  rowLinkClass,
  Unset,
} from "./section.tsx";

const laneLabels = (repository: RepositoryConfigurationView): ReadonlyArray<LabelStateView> =>
  repository.lanes.flatMap(({ sources }) =>
    sources.flatMap((source) => (source._tag === "Label" ? [source.label] : [])),
  );

interface LabelStanding {
  readonly text: string;
  readonly problem: boolean;
}

/** Returns a summary of the repository's lane and declared labels, for example `2 missing on GitHub`. */
const labelStanding = (repository: RepositoryConfigurationView): LabelStanding => {
  const labels = [...repository.declaredLabels, ...laneLabels(repository)];
  if (labels.length === 0) return { text: "No labels", problem: false };
  if (labels.some(({ onGitHub }) => onGitHub === null))
    return { text: "Not polled yet", problem: false };
  const named = (matching: ReadonlyArray<LabelStateView>) =>
    new Set(matching.map(({ name }) => name.toLowerCase())).size;
  const failed = named(labels.filter(({ failure }) => failure !== null));
  const missing = named(labels.filter(({ onGitHub }) => onGitHub === false));
  const problems = [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(missing > 0 ? [`${missing} missing on GitHub`] : []),
  ];
  return problems.length === 0
    ? { text: "All on GitHub", problem: false }
    : { text: problems.join(", "), problem: true };
};

const RepositoryRow = ({ repository }: { readonly repository: RepositoryConfigurationView }) => {
  const navigate = useNavigate();
  const params = splitRepositoryName(repository.name);
  const standing = labelStanding(repository);
  return (
    <OpeningRow
      open={() => void navigate({ to: "/configuration/repositories/$owner/$name", params })}
    >
      <TableCell className="py-3">
        <Link
          to="/configuration/repositories/$owner/$name"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={cn(rowLinkClass, "flex w-fit items-center gap-2")}
        >
          <RepositoryMark repository={repository.name} />
          {repository.name}
        </Link>
      </TableCell>
      <TableCell className="hidden @2xl:table-cell">
        {repository.tags.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          repository.tags.join(", ")
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {repository.lanes.length === 0 ? (
          <span className="text-muted-foreground">Proposed</span>
        ) : (
          repository.lanes.length
        )}
      </TableCell>
      <TableCell
        className={cn(
          "max-sm:whitespace-normal",
          standing.problem ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {standing.text}
      </TableCell>
      <FillCell className="hidden whitespace-normal text-muted-foreground sm:table-cell">
        {repository.loops.length === 0 ? "No loop" : repository.loops.join(", ")}
      </FillCell>
    </OpeningRow>
  );
};

export const RepositoriesList = ({
  configuration,
}: {
  readonly configuration: ConfigurationView;
}) => (
  <ConfigurationPage
    title="Repositories"
    counts={`${configuration.repositories.length} ${configuration.repositories.length === 1 ? "repository" : "repositories"}`}
  >
    {configuration.repositories.length === 0 ? (
      <Missing title="No repositories registered">
        Add each repository under <code>repos</code> in <code>usine.yaml</code>, then reload the
        configuration.
      </Missing>
    ) : (
      <div className="@container -mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Repository</TableHead>
              <TableHead className="hidden @2xl:table-cell">Tags</TableHead>
              <TableHead className="text-right">Lanes</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead className="hidden sm:table-cell">Loops</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.repositories.map((repository) => (
              <RepositoryRow key={repository.name} repository={repository} />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);

/** Renders the problem with a label next to its chip; renders nothing if the label exists on GitHub
 * or the labels have not been polled yet. */
const LabelStanding = ({ label }: { readonly label: LabelStateView }) => {
  if (label.failure !== null)
    return <span className="text-destructive">{label.failure.message}</span>;
  if (label.onGitHub !== false) return null;
  return (
    <span className="text-destructive">
      Missing on GitHub{label.declared ? ", created at the next poll" : ""}
    </span>
  );
};

const SourceChip = ({ source }: { readonly source: LaneSourceView }) =>
  source._tag === "Label" ? (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <LabelBadge name={source.label.name} label={source.label} />
      <span className="text-xs">
        <LabelStanding label={source.label} />
      </span>
    </span>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      {source.state}
    </Badge>
  );

const LanesTable = ({ repository }: { readonly repository: RepositoryConfigurationView }) => (
  <div className="-mx-2">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-right">#</TableHead>
          <TableHead>Lane</TableHead>
          <TableHead>Items with</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repository.lanes.map((lane, index) => (
          <TableRow key={lane.name} className="hover:bg-transparent">
            <TableCell className="py-3 text-right align-top font-mono text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </TableCell>
            <TableCell className="py-3 align-top font-medium">{lane.name}</TableCell>
            <FillCell className="py-3 whitespace-normal">
              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {lane.sources.map((source) => (
                  <li key={source._tag === "Label" ? source.label.name : source.state}>
                    <SourceChip source={source} />
                  </li>
                ))}
              </ul>
            </FillCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

const RepositoryFacts = ({ repository }: { readonly repository: RepositoryConfigurationView }) => (
  <Facts>
    <Fact label="Board">
      <Link
        to="/projects/$owner/$name"
        params={projectParams(repository.name)}
        className="text-primary hover:underline"
      >
        Open the board
      </Link>
    </Fact>
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

export const RepositoryDetail = ({
  owner,
  name,
  configuration,
}: {
  readonly owner: string;
  readonly name: string;
  readonly configuration: ConfigurationView;
}) => {
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
