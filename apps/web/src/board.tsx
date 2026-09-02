import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Item, Repository, Run } from "@usine/core";
import type { BoardItemView, BoardLaneView, ProjectView, RunView } from "@usine/orchestrator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiOk, api } from "./api.ts";
import { failureMessage } from "./operator-copy.ts";

export const itemFailure = (item: BoardItemView): string | null => {
  const failedRun =
    item.runs.find(({ state }) => state === "Failed") ??
    (item.run?.state === "Failed" ? item.run : null);
  if (failedRun === null) return null;
  const attempts = failedRun.attempts;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const outcome = attempts[index]?.outcome;
    if (outcome?._tag === "Failed") return failureMessage(outcome.failure);
  }
  return null;
};

const BoardCard = ({
  item,
  draggable,
  beginDrag,
  endDrag,
  openRun,
}: {
  readonly item: BoardItemView;
  readonly draggable: boolean;
  readonly beginDrag: (item: Item.Number) => void;
  readonly endDrag: () => void;
  readonly openRun: (runId: Run.RunId) => void;
}) => {
  const failure = itemFailure(item);
  const run = item.run;
  const visibleRuns = item.runs.filter(({ state }) => state === "Waiting" || state === "Failed");
  const runsToShow = visibleRuns.length > 0 ? visibleRuns : run === null ? [] : [run];
  const titleClass =
    "h-auto justify-start p-0 text-left text-xs/relaxed font-medium whitespace-normal text-card-foreground hover:text-primary";
  return (
    <Card
      size="sm"
      className={cn(
        "gap-2.5",
        draggable && "cursor-grab active:cursor-grabbing",
        item.needsYou && "ring-needs-you/50",
      )}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(item.number));
        beginDrag(item.number);
      }}
      onDragEnd={endDrag}
    >
      <CardHeader className="gap-0.5">
        <CardDescription className="font-mono">
          {item.kind === "pr" ? "PR" : "Issue"} #{item.number}
        </CardDescription>
        <CardTitle className="font-sans text-xs/relaxed">
          {run === null ? (
            <Button
              variant="link"
              className={titleClass}
              nativeButton={false}
              render={<a href={item.url} target="_blank" rel="noreferrer" />}
            >
              {item.title}
            </Button>
          ) : (
            <Button variant="link" className={titleClass} onClick={() => openRun(run.id)}>
              {item.title}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      {(item.labels.length > 0 || runsToShow.length > 0 || item.needsYou || failure !== null) && (
        <CardContent className="flex flex-col items-start gap-2">
          {item.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <Badge variant="outline" key={label}>
                  {label}
                </Badge>
              ))}
            </div>
          )}
          {runsToShow.map((cardRun) => (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-2"
              key={cardRun.id}
              onClick={() => openRun(cardRun.id)}
            >
              <StatusBadge state={cardRun.state} />
              <span className="text-muted-foreground">{cardRun.agent}</span>
            </Button>
          ))}
          {item.needsYou && <NeedsYouBadge />}
          {failure !== null && <p className="text-destructive wrap-anywhere">{failure}</p>}
          {visibleRuns.some(({ state }) => state === "Waiting") && (
            <p className="text-needs-you">A run on this item is waiting for approval.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
};

const BoardLane = ({
  lane,
  dragged,
  pending,
  drop,
  beginDrag,
  endDrag,
  openRun,
}: {
  readonly lane: BoardLaneView;
  readonly dragged: Item.Number | null;
  readonly pending: boolean;
  readonly drop: (item: Item.Number, lane: BoardLaneView) => void;
  readonly beginDrag: (item: Item.Number) => void;
  readonly endDrag: () => void;
  readonly openRun: (runId: Run.RunId) => void;
}) => {
  const writable = lane._tag === "WritableBoardLane";
  return (
    <Card
      size="sm"
      aria-label={`${lane.name} lane`}
      className={cn(
        "w-72 shrink-0 bg-muted/30 transition-shadow",
        writable && dragged !== null && "ring-run-active",
      )}
      onDragOver={(event) => {
        if (writable && !pending) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (writable && dragged !== null && !pending) drop(dragged, lane);
      }}
    >
      <CardHeader>
        <CardTitle className="wrap-anywhere">{lane.name}</CardTitle>
        <CardDescription>
          {lane.items.length} item{lane.items.length === 1 ? "" : "s"}
        </CardDescription>
        <CardAction>
          <Badge variant="secondary" className="font-mono">
            {lane.origin}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-40 flex-col gap-2">
        {lane.items.length === 0 && <p className="text-muted-foreground">No items.</p>}
        {lane.items.map((item) => (
          <BoardCard
            key={item.itemKey}
            item={item}
            draggable={!pending}
            beginDrag={beginDrag}
            endDrag={endDrag}
            openRun={openRun}
          />
        ))}
      </CardContent>
    </Card>
  );
};

/** The fallback lane holds every unrouted Item, so it leads the board: a drag into an
 * authored lane must not cross every column first. Authored and proposed lanes keep
 * their configured order. */
export const orderLanes = (lanes: ReadonlyArray<BoardLaneView>): ReadonlyArray<BoardLaneView> => [
  ...lanes.filter(({ origin }) => origin === "fallback"),
  ...lanes.filter(({ origin }) => origin !== "fallback"),
];

/** Runs whose Item has no card yet (schedule Runs, quarantined Items) stay reachable here. */
export const runsWithoutCard = (project: ProjectView): ReadonlyArray<RunView> => {
  const carded = new Set(
    project.board.lanes.flatMap(({ items }) => items.map(({ itemKey }) => itemKey)),
  );
  return project.runs.filter(({ itemKey }) => !carded.has(itemKey));
};

const UncardedRuns = ({
  runs,
  openRun,
}: {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (runId: Run.RunId) => void;
}) => (
  <Card className="max-w-5xl">
    <CardHeader>
      <CardTitle>Runs without a card</CardTitle>
      <CardDescription>
        {runs.length} run{runs.length === 1 ? "" : "s"} whose Item has no card on this board
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Loop</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="cursor-pointer" onClick={() => openRun(run.id)}>
              <TableCell className="font-mono font-medium">{run.loop}</TableCell>
              <TableCell className="font-mono">{run.agent}</TableCell>
              <TableCell className="max-w-64 truncate font-mono">{run.itemKey}</TableCell>
              <TableCell>
                <StatusBadge state={run.state} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open run ${run.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRun(run.id);
                  }}
                >
                  <ArrowUpRightIcon aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);

export const ProjectBoard = ({
  project,
  disabled,
  openRun,
}: {
  readonly project: ProjectView;
  readonly disabled: boolean;
  readonly openRun: (runId: Run.RunId) => void;
}) => {
  const queryClient = useQueryClient();
  const [dragged, setDragged] = useState<Item.Number | null>(null);
  const uncarded = runsWithoutCard(project);
  const move = useMutation({
    mutationFn: ({ item, lane }: { readonly item: Item.Number; readonly lane: BoardLaneView }) => {
      const { owner, name } = Repository.parts(project.repository);
      return api(
        `/api/projects/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/items/${item}/lane`,
        ApiOk,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toLane: lane.id }),
        },
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
    onSettled: () => setDragged(null),
  });
  return (
    <main className="flex flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-xl font-medium wrap-anywhere">{project.repository}</h1>
        {project.status === "needs-you" && <NeedsYouBadge />}
      </header>
      {project.board.failures.length > 0 && (
        <ErrorAlert
          className="max-w-3xl"
          title={`${project.board.failures.length} Item projection${project.board.failures.length === 1 ? " was" : "s were"} quarantined`}
          message={project.board.failures.map((failure) => failure.message).join("\n")}
        />
      )}
      <div
        className="flex gap-3 overflow-x-auto pb-3 overscroll-x-contain scrollbar-thin"
        aria-label={`${project.repository} project board`}
      >
        {orderLanes(project.board.lanes).map((lane) => (
          <BoardLane
            key={lane.id}
            lane={lane}
            dragged={dragged}
            pending={disabled || move.isPending}
            drop={(item, target) => move.mutate({ item, lane: target })}
            beginDrag={setDragged}
            endDrag={() => setDragged(null)}
            openRun={openRun}
          />
        ))}
      </div>
      {move.isError && <ErrorAlert className="max-w-3xl" message={move.error.message} />}
      {uncarded.length > 0 && <UncardedRuns runs={uncarded} openRun={openRun} />}
    </main>
  );
};
