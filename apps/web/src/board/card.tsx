import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RunId } from "@usine/core/run";
import { OPEN_STATE_TAGS } from "@usine/core/run/state";
import type {
  BoardLaneView,
  BoardTaskView,
  LabelView,
  RunView,
} from "@usine/orchestrator/operator";
import { LabelBadge } from "@/components/label-badge";
import { StateMark } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import {
  elapsedLabel,
  failureMessage,
  itemKindLabel,
  moveProgressMessage,
  runActionLabel,
  runActionProgress,
  runLineTimeTitle,
} from "../operator-copy.ts";
import { type RunActions, useRunAction } from "../run-actions.ts";
import { type CardMoves, CardMenu } from "./card-menu.tsx";
import type { BoardMoveProgress } from "./moves.ts";

/** Repository labels by name, for GitHub colors and descriptions. */
export type LabelCatalog = ReadonlyMap<string, LabelView>;

const VISIBLE_LABELS = 3;

const OPEN_STATES = new Set<RunView["state"]>(OPEN_STATE_TAGS);

/** The Run a card shows and acts on: an open Run, or a failed one that still needs the operator.
 * Succeeded, canceled, and resolved Runs stay in the drawer and Run history. */
export const currentRun = (item: BoardTaskView): RunView | null => {
  const run = item.run;
  return run !== null && (OPEN_STATES.has(run.state) || run.canResolveFailure) ? run : null;
};

/** The instant a card's Run line counts from: when the Run opened while it waits for approval or a
 * Worker, when its current Attempt started while it runs, and when its last Attempt ended once it
 * failed. Null when the records do not hold that instant. */
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

/** A failed Run that still requests attention, with the message of its latest failed Attempt. */
interface RunFailure {
  readonly run: RunView;
  readonly message: string;
}

/** The newest of the task's Runs whose failure still requests attention, or null when none does. */
const failedRun = (item: BoardTaskView): RunFailure | null => {
  const run =
    [...item.runs].reverse().find(({ canResolveFailure }) => canResolveFailure) ??
    (item.run?.canResolveFailure ? item.run : null);
  if (run === null) return null;
  const attempts = run.attempts;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const outcome = attempts[index]?.outcome;
    if (outcome?._tag === "Failed") return { run, message: failureMessage(outcome.failure) };
  }
  return null;
};

/** The newest failure among the task's Runs that still request attention, or null when none does. */
export const itemFailure = (item: BoardTaskView): string | null => failedRun(item)?.message ?? null;

/** The labels a card shows: its lane's own labels are left out because the column names them. */
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

/** What a card says while a Run action or a move is in flight, if anything is. */
const progressMessage = (
  action: RunActions,
  phase: BoardMoveProgress["phase"] | undefined,
): string | null => {
  if (action.isPending && action.variables !== undefined)
    return runActionProgress[action.variables.request.action];
  return phase === undefined ? null : moveProgressMessage(phase);
};

// The title's hit area stretches over the whole card, so a click anywhere on it opens the Run or Item.
const titleClass =
  "block w-full cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-lg";

const CardTitle = ({
  item,
  openRun,
}: {
  readonly item: BoardTaskView;
  readonly openRun: (runId: RunId) => void;
}) => {
  const run = item.run;
  const text = <span className="line-clamp-2">{item.title}</span>;
  return (
    <h3 className="text-sm/snug font-medium text-card-foreground" title={item.title}>
      {run === null ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          draggable={false}
          className={titleClass}
        >
          {text}
        </a>
      ) : (
        <button type="button" className={titleClass} onClick={() => openRun(run.id)}>
          {text}
        </button>
      )}
    </h3>
  );
};

/** The failure that still needs the operator, with Retry when its Run can be retried. */
const FailureNote = ({
  failure,
  action,
}: {
  readonly failure: RunFailure;
  readonly action: RunActions | null;
}) => (
  <div className="flex flex-col items-start gap-1.5 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
    <p className="line-clamp-2 wrap-anywhere" title={failure.message}>
      {failure.message}
    </p>
    {action !== null && failure.run.canRetry && !action.isPending && (
      <Button
        variant="outline"
        size="xs"
        className="relative z-10"
        onClick={() => action.mutate({ runId: failure.run.id, request: { action: "retry" } })}
      >
        {runActionLabel.retry}
      </Button>
    )}
  </div>
);

const CardFace = ({
  item,
  lane,
  catalog,
  openRun,
  action,
  progress,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly openRun: (runId: RunId) => void;
  /** The card's Run actions, or null on the copy that follows a drag. */
  readonly action: RunActions | null;
  readonly progress: string | null;
}) => {
  const failure = failedRun(item);
  const run = currentRun(item);
  const actionError = action?.error?.message ?? null;
  // Waiting and Failed Runs already show why the card needs the operator; a blocked Item does not.
  const unexplained = item.needsYou && !(run?.canApprove || run?.canResolveFailure);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-3">
      <p className="flex flex-wrap gap-x-3 pr-6 font-mono text-xs text-muted-foreground">
        {item.items.map((member) => (
          <span key={member.itemKey}>
            #{member.number} {itemKindLabel(member.kind)}
          </span>
        ))}
      </p>
      <CardTitle item={item} openRun={openRun} />
      <CardLabels labels={cardLabels(item, lane)} catalog={catalog} />
      {run !== null && <RunLine run={run} />}
      {progress !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress}
        </p>
      )}
      {failure !== null && <FailureNote failure={failure} action={action} />}
      {actionError !== null && (
        <p className="text-xs text-destructive wrap-anywhere">{actionError}</p>
      )}
      {item.conflicting && <p className="text-xs text-destructive">Conflicts with base</p>}
      {unexplained && <p className="text-xs text-needs-you">Needs you</p>}
    </div>
  );
};

const cardClass = (needsYou: boolean) =>
  cn(
    "relative gap-0 py-2.5 transition-[box-shadow] hover:ring-foreground/15 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70",
    needsYou && "ring-needs-you/45 hover:ring-needs-you/65",
  );

/** A Task card in its lane: draggable to another lane, with its actions behind one menu button. */
export const BoardCard = ({
  item,
  lane,
  catalog,
  draggable,
  phase,
  moves,
  openRun,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly draggable: boolean;
  readonly phase: BoardMoveProgress["phase"] | undefined;
  readonly moves: CardMoves;
  readonly openRun: (runId: RunId) => void;
}) => {
  const action = useRunAction();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.itemKey, disabled: !draggable });
  // The menu sits beside the drag activator, not inside it, so pressing it never starts a drag.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "opacity-40")}
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
          openRun={openRun}
          action={action}
          progress={progressMessage(action, phase)}
        />
      </Card>
      <CardMenu
        item={item}
        run={currentRun(item)}
        moves={moves}
        openRun={openRun}
        action={action}
        className="absolute top-1.5 right-1.5"
      />
    </div>
  );
};

/** The card under the pointer while it is dragged. */
export const DraggedCard = ({
  item,
  lane,
  catalog,
}: {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
}) => (
  <Card size="sm" className={cn(cardClass(item.needsYou), "cursor-grabbing shadow-raised")}>
    <CardFace
      item={item}
      lane={lane}
      catalog={catalog}
      openRun={() => {}}
      action={null}
      progress={null}
    />
  </Card>
);
