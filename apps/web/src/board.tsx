import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Item, Repository, Run } from "@usine/core";
import type { BoardItemView, BoardLaneView, ProjectView } from "@usine/orchestrator";
import { useState } from "react";
import { ApiOk, api } from "./api.ts";
import { failureMessage } from "./operator-copy.ts";
import "./board.css";

const StatusMark = ({ state }: { readonly state: string }) => (
  <span className={`status-mark state-${state.toLowerCase()}`} aria-label={state}>
    {state}
  </span>
);

const itemFailure = (item: BoardItemView): string | null => {
  const attempts = item.run?.attempts ?? [];
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
  const title = (
    <>
      <span className="board-item-kind">
        {item.kind === "pr" ? "PR" : "Issue"} #{item.number}
      </span>
      <strong>{item.title}</strong>
    </>
  );
  return (
    <article
      className={`board-card${item.needsYou ? " board-card-needs-you" : ""}`}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(item.number));
        beginDrag(item.number);
      }}
      onDragEnd={endDrag}
    >
      {run === null ? (
        <a className="board-card-title" href={item.url} target="_blank" rel="noreferrer">
          {title}
        </a>
      ) : (
        <button className="board-card-title" onClick={() => openRun(run.id)} type="button">
          {title}
        </button>
      )}
      <div className="board-card-labels">
        {item.labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {run !== null && (
        <div className="board-run-state">
          <StatusMark state={run.state} />
          <span className="annotation">{run.agent}</span>
        </div>
      )}
      {item.needsYou && <span className="needs-you-badge">Needs you</span>}
      {failure !== null && <p className="board-card-error">{failure}</p>}
      {run?.state === "Waiting" && (
        <p className="board-card-note">Approval is waiting in this run.</p>
      )}
    </article>
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
    <section
      className={`board-lane${writable && dragged !== null ? " board-lane-target" : ""}`}
      onDragOver={(event) => {
        if (writable && !pending) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (writable && dragged !== null && !pending) drop(dragged, lane);
      }}
    >
      <header>
        <div>
          <h2>{lane.name}</h2>
          <span className="annotation">
            {lane.items.length} item{lane.items.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="lane-origin">{lane.origin}</span>
      </header>
      <div className="board-cards">
        {lane.items.length === 0 && <p className="empty-copy">No items.</p>}
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
      </div>
    </section>
  );
};

export const ProjectBoard = ({
  project,
  disabled,
  back,
  openRun,
}: {
  readonly project: ProjectView;
  readonly disabled: boolean;
  readonly back: () => void;
  readonly openRun: (runId: Run.RunId) => void;
}) => {
  const queryClient = useQueryClient();
  const [dragged, setDragged] = useState<Item.Number | null>(null);
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
    <main className="board-panel">
      <header className="board-heading">
        <div>
          <button className="back-button" onClick={back} type="button">
            ← Projects
          </button>
          <p className="eyebrow">Project board</p>
          <h1>{project.repository}</h1>
        </div>
        {project.status === "needs-you" && <span className="needs-you-badge">Needs you</span>}
      </header>
      <div className="board-lanes" aria-label={`${project.repository} project board`}>
        {project.board.lanes.map((lane) => (
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
      {move.isError && <p className="board-error error-panel">{move.error.message}</p>}
    </main>
  );
};
