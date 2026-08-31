import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { Run } from "@usine/core";
import { FactoryOverview, RunDetailView } from "@usine/orchestrator";
import type { LoopView, NeedView, RunView, TranscriptEventView } from "@usine/orchestrator";
import { Schema } from "effect";
import { StrictMode, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const ApiOk = Schema.Struct({ ok: Schema.Literal(true) });
const RunSearch = Schema.toStandardSchemaV1(Schema.Struct({ run: Schema.optional(Run.RunId) }));

const api = async <S extends Schema.Codec<unknown, unknown, never, unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await fetch(path, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return Schema.decodeUnknownPromise(schema)(await response.json());
};

const overviewQuery = () => ({
  queryKey: ["overview"] as const,
  queryFn: () => api("/api/overview", FactoryOverview),
  refetchInterval: 2_000,
});

const timeAgo = (value: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

const StatusMark = ({ state }: { readonly state: string }) => (
  <span className={`status-mark state-${state.toLowerCase()}`} aria-label={state}>
    {state}
  </span>
);

const ActionButton = ({
  children,
  className = "",
  disabled,
  onClick,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) => (
  <button className={`action ${className}`} disabled={disabled} onClick={onClick} type="button">
    {children}
  </button>
);

const RunRow = ({ run, open }: { readonly run: RunView; readonly open: () => void }) => (
  <button className="run-row" onClick={open} type="button">
    <span className="run-route">
      <strong>{run.loop}</strong>
      <small>{run.agent}</small>
    </span>
    <StatusMark state={run.state} />
    <span className="annotation">{timeAgo(run.openedAt)}</span>
    <span className="row-arrow" aria-hidden="true">
      ↗
    </span>
  </button>
);

const NeedStrip = ({
  needs,
  openRun,
}: {
  readonly needs: ReadonlyArray<NeedView>;
  readonly openRun: (runId: string) => void;
}) => {
  if (needs.length === 0) {
    return (
      <div className="needs-strip all-clear">
        <span className="strip-label">Needs you</span>
        <span>Nothing is blocked. The floor is moving.</span>
      </div>
    );
  }
  return (
    <section className="needs-strip" aria-label="Items needing intervention">
      <span className="strip-label">Needs you · {needs.length}</span>
      <div className="need-items">
        {needs.map((need) => (
          <button
            className="need-item"
            disabled={need.runId === null}
            key={need.id}
            onClick={() => need.runId !== null && openRun(need.runId)}
            type="button"
          >
            <strong>{need.title}</strong>
            <span>{need.detail}</span>
            {need.repository !== null && <small>{need.repository}</small>}
          </button>
        ))}
      </div>
    </section>
  );
};

const LoopControl = ({
  loop,
  act,
  pending,
}: {
  readonly loop: LoopView;
  readonly act: (loop: LoopView) => void;
  readonly pending: boolean;
}) => (
  <article className="loop-control">
    <div>
      <h3>{loop.name}</h3>
      <p className="annotation">
        {loop.trigger} · {loop.agent}
      </p>
    </div>
    <ActionButton
      className={loop.paused ? "resume" : "pause"}
      disabled={pending}
      onClick={() => act(loop)}
    >
      {loop.paused ? "Unpause" : "Pause"}
    </ActionButton>
  </article>
);

interface TranscriptGroup {
  readonly key: string;
  readonly sequence: number;
  readonly parentId: string;
  readonly events: ReadonlyArray<TranscriptEventView>;
}

const TranscriptEvent = ({ event }: { readonly event: TranscriptEventView }) => (
  <article className={`transcript-event ${event.isError ? "event-error" : ""}`}>
    <header>
      <span>{event.label}</span>
      <time>
        {new Date(event.receivedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
    </header>
    {event.detail !== "" && <pre>{event.detail}</pre>}
  </article>
);

const Transcript = ({ events }: { readonly events: ReadonlyArray<TranscriptEventView> }) => {
  const feed = useMemo(() => {
    const groups = new Map<string, TranscriptGroup>();
    for (const event of events) {
      if (event.scope !== "child" || event.parentId === null) continue;
      const current = groups.get(event.parentId);
      groups.set(event.parentId, {
        key: `child:${event.parentId}`,
        sequence: Math.min(current?.sequence ?? event.sequence, event.sequence),
        parentId: event.parentId,
        events: [...(current?.events ?? []), event],
      });
    }
    return [
      ...events
        .filter((event) => event.scope !== "child")
        .map((event) => ({ key: `event:${event.sequence}`, sequence: event.sequence, event })),
      ...groups.values(),
    ].sort((left, right) => left.sequence - right.sequence);
  }, [events]);

  if (feed.length === 0) return <p className="empty-copy">Waiting for the first agent message…</p>;
  return (
    <div className="transcript">
      {feed.map((item) =>
        "event" in item ? (
          <TranscriptEvent event={item.event} key={item.key} />
        ) : (
          <details className="child-activity" key={item.key}>
            <summary>
              Child activity <span>{item.events.length} events</span>
            </summary>
            <div>
              {item.events.map((event) => (
                <TranscriptEvent event={event} key={event.sequence} />
              ))}
            </div>
          </details>
        ),
      )}
    </div>
  );
};

const RunDrawer = ({ runId, close }: { readonly runId: string; readonly close: () => void }) => {
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api(`/api/runs/${encodeURIComponent(runId)}`, RunDetailView),
    refetchInterval: 1_000,
  });
  const mutation = useMutation({
    mutationFn: (act: "approve" | "retry" | "cancel") =>
      api(`/api/runs/${encodeURIComponent(runId)}/${act}`, ApiOk, { method: "POST" }),
    onSuccess: async () => {
      setConfirmCancel(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]);
    },
  });
  const run = detail.data?.run;
  return (
    <div className="drawer-shell" role="dialog" aria-modal="true" aria-label="Run detail">
      <button
        className="drawer-scrim"
        onClick={close}
        type="button"
        aria-label="Close run detail"
      />
      <aside className="run-drawer">
        <header className="drawer-heading">
          <div>
            <p className="eyebrow">Run detail</p>
            <h2>{run?.loop ?? "Loading…"}</h2>
            {run !== undefined && (
              <p className="annotation">
                {run.repository} · {run.id}
              </p>
            )}
          </div>
          <button className="close-button" onClick={close} type="button" aria-label="Close">
            ×
          </button>
        </header>
        {detail.isError && <p className="error-panel">{detail.error.message}</p>}
        {run !== undefined && (
          <>
            <div className="run-summary">
              <StatusMark state={run.state} />
              <span className="annotation">{run.agent}</span>
              <span className="annotation">
                {run.attempts.length} attempt{run.attempts.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="drawer-actions">
              {run.canApprove && (
                <ActionButton
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate("approve")}
                >
                  Approve
                </ActionButton>
              )}
              {run.canRetry && (
                <ActionButton
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate("retry")}
                >
                  Retry
                </ActionButton>
              )}
              {run.canCancel && !confirmCancel && (
                <ActionButton
                  className="danger-quiet"
                  disabled={mutation.isPending}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel
                </ActionButton>
              )}
              {run.canCancel && confirmCancel && (
                <ActionButton
                  className="danger"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate("cancel")}
                >
                  Confirm cancel
                </ActionButton>
              )}
            </div>
            {mutation.isError && <p className="error-panel">{mutation.error.message}</p>}
            <section className="drawer-section">
              <h3>Task</h3>
              <p>{run.task}</p>
            </section>
            {run.resultMessage !== null && (
              <section className="drawer-section">
                <h3>Result</h3>
                <p>{run.resultMessage}</p>
                {run.pullRequestUrl !== null && (
                  <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">
                    Open pull request ↗
                  </a>
                )}
              </section>
            )}
            <section className="drawer-section transcript-section">
              <h3>Live transcript</h3>
              <Transcript events={detail.data?.transcript ?? []} />
            </section>
          </>
        )}
      </aside>
    </div>
  );
};

const FactoryScreen = () => {
  const navigate = useNavigate({ from: "/" });
  const search = indexRoute.useSearch();
  const overview = useQuery(overviewQuery());
  const queryClient = useQueryClient();
  const pauseMutation = useMutation({
    mutationFn: (loop: LoopView) =>
      api(
        `/api/loops/${encodeURIComponent(loop.name)}/${loop.paused ? "unpause" : "pause"}`,
        ApiOk,
        { method: "POST" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
  const openRun = (runId: string) => navigate({ search: { run: runId } });
  const closeRun = () => navigate({ search: {} });

  if (overview.isPending)
    return (
      <main className="boot-screen">
        <span>USINE</span>
        <p>Opening the factory floor…</p>
      </main>
    );
  if (overview.isError)
    return (
      <main className="boot-screen error-panel">
        <span>OFFLINE</span>
        <p>{overview.error.message}</p>
      </main>
    );
  const data = overview.data;
  return (
    <div className="factory-shell">
      <header className="masthead">
        <div className="wordmark">
          <span className="mark">U</span>
          <div>
            <p>Usine</p>
            <small>Factory floor · local</small>
          </div>
        </div>
        <div className="live-indicator">
          <i /> live
        </div>
      </header>
      {data._tag === "NeedsSetup" && (
        <section className="setup-banner">
          <p className="eyebrow">Setup required · {data.errorTag}</p>
          <h1>The floor is ready. GitHub is not connected yet.</h1>
          <p>{data.message}</p>
        </section>
      )}
      <NeedStrip needs={data.needsYou} openRun={openRun} />
      <main className="floor-grid">
        <section className="projects-panel">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Observe</p>
              <h1>Projects</h1>
            </div>
            <span className="annotation">{data.projects.length} registered</span>
          </header>
          <div className="projects-list">
            {data.projects.map((project) => (
              <article className="project" key={project.repository}>
                <header>
                  <div>
                    <h2>{project.repository}</h2>
                    <p className="annotation">
                      {project.runs.length} recorded run{project.runs.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className={`project-status project-${project.status}`}>
                    {project.status}
                  </span>
                </header>
                {project.runs.length === 0 ? (
                  <p className="empty-copy">No runs yet.</p>
                ) : (
                  <div className="run-list">
                    {project.runs.slice(0, 8).map((run) => (
                      <RunRow key={run.id} run={run} open={() => openRun(run.id)} />
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
        <aside className="loops-panel">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Intervene</p>
              <h2>Loops</h2>
            </div>
          </header>
          <p className="aside-copy">Runtime controls. Authored loop files remain untouched.</p>
          <div className="loop-list">
            {data.loops.map((loop) => (
              <LoopControl
                key={loop.name}
                loop={loop}
                pending={pauseMutation.isPending || data._tag === "NeedsSetup"}
                act={(value) => pauseMutation.mutate(value)}
              />
            ))}
          </div>
          {pauseMutation.isError && <p className="error-panel">{pauseMutation.error.message}</p>}
        </aside>
      </main>
      {search.run !== undefined && <RunDrawer runId={search.run} close={closeRun} />}
    </div>
  );
};

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: RunSearch,
  component: FactoryScreen,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 500 } },
});
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root mount point");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
