import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import { isSettledItemState } from "@usine/config/board";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { OPEN_STATE_TAGS } from "@usine/core/run/state";
import type {
  BoardLaneView,
  BoardTaskView,
  LabelView,
  RunView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { LabelBadge } from "~/components/label-badge";
import { StateMark } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { ItemMark } from "~/components/item/mark";
import { useNow } from "~/hooks/use-now";
import { cn } from "~/lib/utils";
import {
  elapsedLabel,
  failureMessage,
  moveProgressMessage,
  runActionLabel,
  runActionProgress,
  runAgainBlocked,
  runAgainProgress,
  runLineTimeTitle,
} from "~/lib/strings";
import { projectParams } from "~/lib/overview";
import { type RunActions, useRunAction } from "~/hooks/runs/actions";
import { StallAction } from "~/components/stall/action";
import { stallNamesLoop, stallSentence } from "~/lib/stall/strings";
import { stallRun, taskNumber } from "~/lib/tasks/model";
import { type CardMoves, CardMenu } from "~/features/projects/components/card-menu";
import type { BoardMoveProgress } from "~/hooks/projects/moves";
import { type CardRunAgain, useCardRunAgain } from "~/hooks/projects/run-again";

export type LabelCatalog = ReadonlyMap<string, LabelView>;

const VISIBLE_LABELS = 3;

const OPEN_STATES = new Set<RunView["state"]>(OPEN_STATE_TAGS);

/**
 * Returns whether the operator must resolve the failure of `run`, one of the Task's Runs: it's
 * unresolved, and the Run's Item isn't closed or merged.
 */
const failureNeedsYou = (item: BoardTaskView, run: RunView): boolean =>
  run.canResolveFailure &&
  !item.items.some(({ itemKey, state }) => itemKey === run.itemKey && isSettledItemState(state));

/** Returns the card's Run: an open Run or a failed Run that needs the operator, else `null`. */
export const currentRun = (item: BoardTaskView): RunView | null => {
  const run = item.run;
  return run !== null && (OPEN_STATES.has(run.state) || failureNeedsYou(item, run)) ? run : null;
};

/** Returns when the Run opened while it waits, when the current Attempt started while it runs, or
 * when the last Attempt ended once it failed. Returns `null` if that time is not recorded. */
export const runLineSince = (run: RunView): string | null => {
  const last = run.attempts.at(-1);
  switch (run.state) {
    case "Pending":
    case "Waiting":
    case "Queued":
      return run.openedAt;
    case "Running":
      return last !== undefined && last.outcome === null ? last.startedAt : null;
    case "Failed":
      return last?.endedAt ?? null;
    case "Succeeded":
    case "Canceled":
      return null;
  }
};

/** A failed Run that needs attention, with the message of its latest failed Attempt. */
interface RunFailure {
  readonly run: RunView;
  readonly message: string;
}

/** Returns the newest Run whose failure needs attention, or `null`. */
const failedRun = (item: BoardTaskView): RunFailure | null => {
  const run = [...item.runs].reverse().find((candidate) => failureNeedsYou(item, candidate));
  if (run === undefined) return null;
  const attempts = run.attempts;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const outcome = attempts[index]?.outcome;
    if (outcome?._tag === "Failed") return { run, message: failureMessage(outcome.failure) };
  }
  return null;
};

/** Returns the failure message of the newest Run that needs attention, or `null`. */
export const itemFailure = (item: BoardTaskView): string | null => failedRun(item)?.message ?? null;

/** Returns the card's labels without the lane's own labels. */
export const cardLabels = (item: BoardTaskView, lane: BoardLaneView): ReadonlyArray<string> => {
  const own = new Set<string>(lane._tag === "WritableBoardLane" ? lane.labels : []);
  for (const source of lane.sources) if ("label" in source) own.add(source.label);
  return item.labels.filter((label) => !own.has(label));
};

const CardLabels = ({
  labels,
  catalog,
}: {
  readonly labels: ReadonlyArray<string>;
  readonly catalog: LabelCatalog;
}) => {
  if (labels.length === 0) return null;
  const hidden = labels.slice(VISIBLE_LABELS);
  return (
    <div className="flex flex-wrap gap-1">
      {labels.slice(0, VISIBLE_LABELS).map((label) => (
        <LabelBadge key={label} name={label} label={catalog.get(label)} />
      ))}
      {hidden.length > 0 && (
        <Badge
          variant="outline"
          className="text-muted-foreground tabular-nums"
          title={hidden.join(", ")}
          aria-label={`${hidden.length} more: ${hidden.join(", ")}`}
        >
          +{hidden.length}
        </Badge>
      )}
    </div>
  );
};

const RunLine = ({ run }: { readonly run: RunView }) => {
  const now = useNow(30_000);
  const since = runLineSince(run);
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <StateMark state={run.state} className="mr-0.5" />
      <span className="truncate text-foreground">{run.loop}</span>
      <span className="shrink-0">{run.state}</span>
      {since !== null && (
        <time
          className="shrink-0 font-mono tabular-nums"
          dateTime={since}
          title={runLineTimeTitle(run.state, since)}
        >
          {elapsedLabel(since, now)}
        </time>
      )}
      <span className="ml-auto truncate pl-2">{run.agent}</span>
    </p>
  );
};

/** Returns the progress text of a pending Run action, Run again, or move, or `null`. */
const progressMessage = (
  action: RunActions,
  again: CardRunAgain,
  phase: BoardMoveProgress["phase"] | undefined,
): string | null => {
  if (action.isPending && action.variables !== undefined)
    return runActionProgress[action.variables.request.action];
  if (again.isPending) return runAgainProgress;
  return phase === undefined ? null : moveProgressMessage(phase);
};

// The title's click area covers the whole card, so clicking anywhere opens the Task page.
const titleClass =
  "block w-full cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-lg";

/** Renders the title as a link to the Task page at the originating Item's number. */
const CardTitle = ({
  item,
  repository,
}: {
  readonly item: BoardTaskView;
  readonly repository: RepositoryName;
}) => (
  <h3 className="text-sm/snug font-medium text-card-foreground" title={item.title}>
    <Link
      to="/projects/$owner/$name/tasks/$number"
      params={{ ...projectParams(repository), number: taskNumber(item) }}
      draggable={false}
      className={titleClass}
    >
      <span className="line-clamp-2">{item.title}</span>
    </Link>
  </h3>
);

const FailureNote = ({
  failure,
  children,
}: {
  readonly failure: RunFailure;
  readonly children: ReactNode;
}) => (
  <div className="flex flex-col items-start gap-1.5 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
    <p className="line-clamp-2 wrap-anywhere" title={failure.message}>
      {failure.message}
    </p>
    {children}
  </div>
);

const RetryButton = ({
  failure,
  action,
}: {
  readonly failure: RunFailure;
  readonly action: RunActions | null;
}) =>
  action !== null && failure.run.canRetry && !action.isPending ? (
    <Button
      variant="outline"
      size="xs"
      className="relative z-10"
      onClick={() => action.mutate({ runId: failure.run.id, request: { action: "retry" } })}
    >
      {runActionLabel.retry}
    </Button>
  ) : null;

/** `named` prefixes the Loop name when neither the card's Run line nor the stall text includes it. */
const StallNote = ({
  stalled,
  named,
  children,
}: {
  readonly stalled: StalledItemView;
  readonly named: boolean;
  readonly children: ReactNode;
}) => {
  const now = useNow(30_000);
  const sentence = stallSentence(stalled, now);
  return (
    <div data-slot="stall-note" className="flex flex-col items-start gap-1.5 text-xs">
      <p className="line-clamp-3 text-muted-foreground" title={`${stalled.loop}: ${sentence}`}>
        {named && <span className="font-medium text-foreground">{stalled.loop} </span>}
        {sentence}
      </p>
      {children}
    </div>
  );
};

const CardFace = ({
  item,
  lane,
  catalog,
  repository,
  stall,
  readOnly,
  action,
  again,
  progress,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly repository: RepositoryName;
  readonly stall: StalledItemView | null;
  readonly readOnly: boolean;
  /** The card's Run actions, or `null` on the drag overlay copy. */
  readonly action: RunActions | null;
  /** The card's Run again requests, or `null` on the drag overlay copy. */
  readonly again: CardRunAgain | null;
  readonly progress: string | null;
}) => {
  const failure = failedRun(item);
  const run = currentRun(item);
  const actionError = action?.error?.message ?? null;
  const runAgainError = again?.error?.message ?? null;
  // If the stall is for the failure note's Run, the note shows it, with a suppression's action.
  const onFailure =
    stall !== null &&
    failure !== null &&
    (stall.reason._tag === "RunFailed" || stall.reason._tag === "SuppressedForOperator") &&
    stall.reason.run.id === failure.run.id;
  const stallAction =
    stall === null || action === null ? null : (
      <StallAction stalled={stall} readOnly={readOnly} appearance="card" />
    );
  // Waiting and Failed Runs explain why the card needs the operator; a blocked Item does not.
  const unexplained =
    item.needsYou && !(run?.canApprove || run?.canResolveFailure) && stall === null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-3">
      <p className="flex flex-wrap items-baseline gap-x-2.5 pr-6">
        {item.items.map((member) => (
          <ItemMark key={member.itemKey} item={member} className="relative z-10" />
        ))}
      </p>
      <CardTitle item={item} repository={repository} />
      <CardLabels labels={cardLabels(item, lane)} catalog={catalog} />
      {run !== null && <RunLine run={run} />}
      {progress !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress}
        </p>
      )}
      {failure !== null && (
        <FailureNote failure={failure}>
          {onFailure && stall?.reason._tag === "SuppressedForOperator" ? (
            stallAction
          ) : (
            <RetryButton failure={failure} action={action} />
          )}
        </FailureNote>
      )}
      {stall !== null && !onFailure && (
        <StallNote
          stalled={stall}
          named={(run === null || stallRun(stall)?.id !== run.id) && !stallNamesLoop(stall)}
        >
          {stallAction}
        </StallNote>
      )}
      {again?.data?._tag === "CycleBlocked" && (
        <p role="status" className="text-xs text-needs-you">
          {runAgainBlocked}
        </p>
      )}
      {actionError !== null && (
        <p className="text-xs text-destructive wrap-anywhere">{actionError}</p>
      )}
      {runAgainError !== null && (
        <p className="text-xs text-destructive wrap-anywhere">{runAgainError}</p>
      )}
      {item.conflicting && <p className="text-xs text-destructive">Conflicts with base</p>}
      {unexplained && <p className="text-xs text-needs-you">Needs attention</p>}
    </div>
  );
};

const cardClass = (needsYou: boolean) =>
  cn(
    "relative gap-0 py-2.5 transition-[box-shadow] hover:ring-foreground/15 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70",
    needsYou && "ring-needs-you/45 hover:ring-needs-you/65",
  );

export const BoardCard = ({
  item,
  lane,
  catalog,
  draggable,
  phase,
  moves,
  stall,
  readOnly,
  openRun,
  repository,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly repository: RepositoryName;
  readonly draggable: boolean;
  readonly phase: BoardMoveProgress["phase"] | undefined;
  readonly moves: CardMoves;
  /** The desk's stall entry for the Task, or `null` if it is not stalled. */
  readonly stall: StalledItemView | null;
  /** Whether to hide the stall's action, as during setup. */
  readonly readOnly: boolean;
  readonly openRun: (runId: RunId) => void;
}) => {
  const action = useRunAction();
  const again = useCardRunAgain(item.itemKey, openRun);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.itemKey,
    disabled: { draggable: !draggable, droppable: lane._tag !== "WritableBoardLane" },
  });
  // The menu is next to the drag activator, not inside it, so pressing it does not start a drag.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/task relative", isDragging && "opacity-40")}
    >
      <Card
        ref={setActivatorNodeRef}
        size="sm"
        className={cn(
          cardClass(item.needsYou),
          draggable && "touch-none focus-visible:ring-2 focus-visible:ring-ring/70",
        )}
        {...(draggable && attributes)}
        {...(draggable && listeners)}
      >
        <CardFace
          item={item}
          lane={lane}
          catalog={catalog}
          repository={repository}
          stall={stall}
          readOnly={readOnly}
          action={action}
          again={again}
          progress={progressMessage(action, again, phase)}
        />
      </Card>
      <CardMenu
        item={item}
        run={currentRun(item)}
        moves={moves}
        openRun={openRun}
        action={action}
        again={again}
        className="absolute top-1.5 right-1.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/task:opacity-100 [@media(hover:hover)]:group-focus-within/task:opacity-100 [@media(hover:hover)]:aria-expanded:opacity-100"
      />
    </div>
  );
};

export const DraggedCard = ({
  item,
  lane,
  catalog,
  repository,
  stall,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly repository: RepositoryName;
  readonly stall: StalledItemView | null;
}) => (
  <Card size="sm" className={cn(cardClass(item.needsYou), "cursor-grabbing shadow-raised")}>
    <CardFace
      item={item}
      lane={lane}
      catalog={catalog}
      repository={repository}
      stall={stall}
      readOnly
      action={null}
      again={null}
      progress={null}
    />
  </Card>
);
