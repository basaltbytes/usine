import { PauseIcon, PlayIcon, WarningIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import type {
  ConfigurationView,
  LoopFileView,
  LoopSelectorView,
  QuarantinedLoopView,
} from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { FillCell } from "@/components/fill-cell";
import { RepositoryMark } from "@/components/repository-mark";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { brainLine, triggerLabel } from "../operator-copy.ts";
import { approvalLabel, loopCounts, permissionsLabel, plural } from "./copy.ts";
import { FileError } from "./file-error.tsx";
import { interpolations, PromptMarkdown } from "./prompt.tsx";
import { usePauseLoop } from "./query.ts";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Fact,
  Facts,
  Frontmatter,
  Missing,
  NotLoaded,
  OpeningRow,
  rowLinkClass,
  Unset,
} from "./section.tsx";

type PauseLoop = ReturnType<typeof usePauseLoop>;

const LoopState = ({ paused }: { readonly paused: boolean }) => (
  <StatusBadge state={paused ? "paused" : "live"} label={paused ? "Paused" : "Active"} />
);

/** Renders nothing when operator actions are unavailable, as in setup mode. */
const PauseButton = ({
  loop,
  pause,
  variant,
}: {
  readonly loop: LoopFileView;
  readonly pause: PauseLoop;
  readonly variant: "ghost" | "outline";
}) => {
  const sending = pause.isPending && pause.variables.loop === loop.name;
  return (
    <Button
      variant={variant}
      disabled={pause.isPending}
      className={variant === "ghost" ? "text-muted-foreground" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        pause.mutate({ loop: loop.name, paused: loop.paused });
      }}
    >
      {loop.paused ? (
        <PlayIcon data-icon="inline-start" aria-hidden="true" />
      ) : (
        <PauseIcon data-icon="inline-start" aria-hidden="true" />
      )}
      <span className={variant === "ghost" ? "max-sm:sr-only" : undefined}>
        {sending ? (loop.paused ? "Resuming…" : "Pausing…") : loop.paused ? "Resume" : "Pause"}
      </span>
      {variant === "ghost" && <span className="sr-only"> {loop.name}</span>}
    </Button>
  );
};

const LoopRow = ({
  loop,
  pause,
}: {
  readonly loop: LoopFileView;
  readonly pause: PauseLoop | null;
}) => {
  const navigate = useNavigate();
  const params = { loop: loop.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/loops/$loop", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/loops/$loop"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {loop.name}
        </Link>
      </TableCell>
      <TableCell>{triggerLabel(loop.stream)}</TableCell>
      <FillCell className="hidden lg:table-cell">
        <code
          className="block truncate font-mono text-xs text-muted-foreground [font-variant-ligatures:none]"
          title={loop.condition}
        >
          {loop.condition}
        </code>
      </FillCell>
      <TableCell className="hidden sm:table-cell">{loop.agent}</TableCell>
      <TableCell className="hidden md:table-cell">{approvalLabel[loop.approval]}</TableCell>
      <TableCell>
        <LoopState paused={loop.paused} />
      </TableCell>
      <TableCell className="text-right">
        {pause !== null && <PauseButton loop={loop} pause={pause} variant="ghost" />}
      </TableCell>
    </OpeningRow>
  );
};

const QuarantinedRow = ({ loop }: { readonly loop: QuarantinedLoopView }) => {
  const navigate = useNavigate();
  const params = { loop: loop.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/loops/$loop", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/loops/$loop"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {loop.name}
        </Link>
      </TableCell>
      <TableCell colSpan={4} className="max-w-0">
        <p className="truncate text-destructive" title={loop.error.message}>
          {loop.error.message}
        </p>
      </TableCell>
      <TableCell>
        <NotLoaded />
      </TableCell>
      <TableCell />
    </OpeningRow>
  );
};

/** `pause` is `null` if operator actions are unavailable. */
export const LoopsList = ({
  configuration,
  pause,
}: {
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
}) => (
  <ConfigurationPage title="Loops" counts={loopCounts(configuration)}>
    {pause?.isError === true && <ErrorAlert message={pause.error.message} />}
    {configuration.loops.length === 0 && configuration.quarantinedLoops.length === 0 ? (
      <Missing title="No loops">
        Add a Markdown file under <code>loops/</code> in the instance folder, then reload the
        configuration.
      </Missing>
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="lg:w-56">Loop</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="hidden lg:table-cell">Condition</TableHead>
              <TableHead className="hidden sm:table-cell">Agent</TableHead>
              <TableHead className="hidden md:table-cell">Approval</TableHead>
              <TableHead>State</TableHead>
              <TableHead>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.quarantinedLoops.map((loop) => (
              <QuarantinedRow key={loop.file} loop={loop} />
            ))}
            {configuration.loops.map((loop) => (
              <LoopRow key={loop.name} loop={loop} pause={pause} />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);

const RepositoryLink = ({ repository }: { readonly repository: RepositoryName }) => {
  const { owner, name } = splitRepositoryName(repository);
  return (
    <Link
      to="/configuration/repositories/$owner/$name"
      params={{ owner, name }}
      className="flex w-fit items-center gap-2 text-primary hover:underline"
    >
      <RepositoryMark repository={repository} />
      {repository}
    </Link>
  );
};

const LoopFacts = ({
  loop,
  configuration,
}: {
  readonly loop: LoopFileView;
  readonly configuration: ConfigurationView;
}) => {
  const agent = configuration.agents.find(({ name }) => name === loop.agent);
  return (
    <Facts>
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
      <Fact label="Approval">{approvalLabel[loop.approval]}</Fact>
      <Fact label="Max cycles">
        <span className="tabular-nums">{loop.maxCycles}</span>{" "}
        <Unset>runs per item before a reset</Unset>
      </Fact>
      <Fact label="Permissions">{permissionsLabel[loop.permissions]}</Fact>
      <Fact label="Priority">
        {loop.priority === null ? (
          <Unset>None; runs wait in lane order</Unset>
        ) : (
          <>
            <span className="tabular-nums">{loop.priority}</span>{" "}
            <Unset>queued ahead of runs in lane order</Unset>
          </>
        )}
      </Fact>
      <Fact label="Step">
        <code className="font-mono text-xs">{loop.step}</code>
      </Fact>
    </Facts>
  );
};

const triggerEntries = (loop: LoopFileView): ReadonlyArray<readonly [string, string]> => [
  ["on", loop.stream],
  ["if", loop.condition],
  ...(loop.cron === null ? [] : [["cron", loop.cron] as const]),
  ...(loop.timeZone === null ? [] : [["tz", loop.timeZone] as const]),
];

const selectorEntries = ({
  repos,
  tags,
}: LoopSelectorView): ReadonlyArray<readonly [string, string]> => [
  ...(repos === null ? [] : [["repos", repos.join(", ")] as const]),
  ...(tags === null ? [] : [["tags", tags.join(", ")] as const]),
];

const LoadedLoop = ({
  loop,
  configuration,
  pause,
}: {
  readonly loop: LoopFileView;
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
}) => {
  const expressions = interpolations(loop.prompt).length;
  return (
    <ConfigurationPage
      title={loop.name}
      marks={<LoopState paused={loop.paused} />}
      file={loop.file}
      actions={pause !== null && <PauseButton loop={loop} pause={pause} variant="outline" />}
    >
      {pause?.isError === true && <ErrorAlert message={pause.error.message} />}
      <DetailColumns facts={<LoopFacts loop={loop} configuration={configuration} />}>
        <DetailSection title="Trigger">
          <Frontmatter entries={triggerEntries(loop)} />
          {loop.undeclaredLabels.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <WarningIcon weight="fill" className="mt-0.5 size-3 shrink-0 text-warning" />
              <span>
                Condition uses{" "}
                {loop.undeclaredLabels.length === 1 ? "an undeclared label" : "undeclared labels"}:{" "}
                {loop.undeclaredLabels.join(", ")}. usine creates only the labels under{" "}
                <code>labels</code> in <code>usine.yaml</code>.
              </span>
            </p>
          )}
        </DetailSection>
        <DetailSection title="Selector">
          {loop.selector === null ? (
            <p className="text-muted-foreground">No selector: every registered repository</p>
          ) : (
            <Frontmatter entries={selectorEntries(loop.selector)} />
          )}
        </DetailSection>
        <DetailSection
          title="Prompt"
          aside={
            expressions === 0
              ? "Same text for every run"
              : `${plural(expressions, "outlined expression")} filled in from each item`
          }
        >
          <PromptMarkdown template={loop.prompt} />
        </DetailSection>
      </DetailColumns>
    </ConfigurationPage>
  );
};

/** `name` is the Loop file name without `.md`. */
export const LoopDetail = ({
  name,
  configuration,
  pause,
}: {
  readonly name: string;
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
}) => {
  const loop = configuration.loops.find((candidate) => candidate.name === name);
  if (loop !== undefined)
    return <LoadedLoop loop={loop} configuration={configuration} pause={pause} />;
  const quarantined = configuration.quarantinedLoops.find((candidate) => candidate.name === name);
  if (quarantined !== undefined)
    return (
      <ConfigurationPage title={quarantined.name} marks={<NotLoaded />} file={quarantined.file}>
        <FileError error={quarantined.error} consequence="No runs until the file loads." />
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage title={name}>
      <Missing title="Loop not found">
        The configuration has no file <code>loops/{name}.md</code>.{" "}
        <Link to="/configuration/loops" className="text-primary hover:underline">
          See all loops
        </Link>
        .
      </Missing>
    </ConfigurationPage>
  );
};
