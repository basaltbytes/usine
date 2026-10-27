import { Link, useNavigate } from "@tanstack/react-router";
import { splitRepositoryName } from "@usine/core/repository";
import type { LabelStateView, RepositoryConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { RepositoryMark } from "~/components/repository-mark";
import { TableCell } from "~/components/ui/table";
import { laneLabels } from "~/features/configuration/lib/repositories";
import type { LabelStanding } from "~/features/configuration/lib/repositories";
import { OpeningRow, rowLinkClass } from "~/features/configuration/components/section";
import { cn } from "~/lib/utils";

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

type RepositoryRowProps = { readonly repository: RepositoryConfigurationView };

export const RepositoryRow = ({ repository }: RepositoryRowProps) => {
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
