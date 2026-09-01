import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import {
  QueryClient,
  QueryClientProvider,
  type Query,
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
import type {
  LoopView,
  NeedView,
  RunView,
  TranscriptPageCursor,
} from "@usine/orchestrator";
import { Schema } from "effect";
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { brainLine, failureMessage, needCopy } from "./operator-copy.ts";
import {
  mergeTranscript,
  replaceEarlierCursor,
  Transcript,
} from "./run-transcript.tsx";
import "./styles.css";

const ApiOk = Schema.Struct({ ok: Schema.Literal(true) });
const ApiError = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
});
const isApiError = Schema.is(ApiError);
const RunSearch = Schema.toStandardSchemaV1(
  Schema.Struct({ run: Schema.optional(Run.RunId) }),
);
const ACTIVE_OVERVIEW_REFRESH_MS = 2_000;
const IDLE_OVERVIEW_REFRESH_MS = 15_000;

const errorMessage = async (response: Response): Promise<string> => {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (isApiError(parsed)) return parsed.message;
  } catch {
    // Not the ApiError envelope; fall through to the raw body.
  }
  return body || `Request failed with status ${response.status}`;
};

const api = async <S extends Schema.Codec<unknown, unknown, never, unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return Schema.decodeUnknownPromise(schema)(await response.json());
};

const mergeRunDetail = (previous: unknown, next: unknown): unknown => {
  if (!(previous instanceof RunDetailView) || !(next instanceof RunDetailView))
    return next;
  return new RunDetailView({
    ...next,
    transcript: mergeTranscript(previous.transcript, next.transcript),
    earlierTranscript: previous.earlierTranscript,
  });
};

const overviewQuery = () => ({
  queryKey: ["overview"] as const,
  queryFn: () => api("/api/overview", FactoryOverview),
  refetchInterval: (
    query: Query<
      FactoryOverview,
      Error,
      FactoryOverview,
      readonly ["overview"]
    >,
  ) => {
    const overview = query.state.data;
    if (overview?._tag === "NeedsSetup") return false;
    const hasOpenRun = overview?.projects.some((project) =>
      project.runs.some(({ canCancel }) => canCancel),
    );
    return hasOpenRun === true
      ? ACTIVE_OVERVIEW_REFRESH_MS
      : IDLE_OVERVIEW_REFRESH_MS;
  },
});

const timeAgo = (value: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

const jsonGist = (value: Schema.Json): string => JSON.stringify(value, null, 2);

const StatusMark = ({ state }: { readonly state: string }) => (
  <span
    className={`status-mark state-${state.toLowerCase()}`}
    aria-label={state}
  >
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
  <button
    className={`action ${className}`}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

const PausedMark = () => <span className="paused-mark">paused</span>;

const RunRow = ({
  run,
  open,
}: {
  readonly run: RunView;
  readonly open: () => void;
}) => (
  <button className="run-row" onClick={open} type="button">
    <span className="run-route">
      <strong>{run.loop}</strong>
      <small>
        {run.agent}
        {run.loopPaused && <PausedMark />}
      </small>
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
  readonly openRun: (runId: Run.RunId) => void;
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
        {needs.map((need) => {
          const copy = needCopy(need);
          const body = (
            <>
              <strong>{copy.title}</strong>
              <span>{copy.detail}</span>
              {copy.repository !== null && <small>{copy.repository}</small>}
            </>
          );
          const runId = copy.runId;
          return runId !== null ? (
            <button
              className="need-item"
              key={need.id}
              onClick={() => openRun(runId)}
              type="button"
            >
              {body}
            </button>
          ) : (
            <article className="need-item need-notice" key={need.id}>
              {body}
            </article>
          );
        })}
      </div>
    </section>
  );
};

const LoopCard = ({
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

const RunDrawer = ({
  runId,
  close,
}: {
  readonly runId: Run.RunId;
  readonly close: () => void;
}) => {
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const detail = useQuery<RunDetailView>({
    queryKey: ["run", runId],
    queryFn: () => {
      const key = ["run", runId] as const;
      const previous = queryClient.getQueryData<RunDetailView>(key);
      const cursor = previous?.transcript.at(-1)?.sequence;
      const search = cursor === undefined ? "" : `?after=${cursor}`;
      return api(
        `/api/runs/${encodeURIComponent(runId)}${search}`,
        RunDetailView,
      );
    },
    structuralSharing: mergeRunDetail,
    refetchInterval: (query) =>
      query.state.data?.run.canCancel === true ? 1_000 : false,
  });
  const mutation = useMutation({
    mutationFn: (act: "approve" | "retry" | "cancel") =>
      api(`/api/runs/${encodeURIComponent(runId)}/${act}`, ApiOk, {
        method: "POST",
      }),
    onSuccess: async () => {
      setConfirmCancel(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]);
    },
  });
  const earlierMutation = useMutation({
    mutationFn: (cursor: TranscriptPageCursor) =>
      api(
        `/api/runs/${encodeURIComponent(runId)}?attempt=${encodeURIComponent(cursor.attemptId)}&before=${cursor.before}`,
        RunDetailView,
      ),
    onSuccess: (page, cursor) => {
      const key = ["run", runId] as const;
      const previous = queryClient.getQueryData<RunDetailView>(key);
      if (previous === undefined) return;
      queryClient.setQueryData(
        key,
        new RunDetailView({
          ...previous,
          transcript: mergeTranscript(previous.transcript, page.transcript),
          earlierTranscript: replaceEarlierCursor(
            previous.earlierTranscript,
            cursor.attemptId,
            page.earlierTranscript,
          ),
        }),
      );
    },
  });
  const run = detail.data?.run;
  const earlier = detail.data?.earlierTranscript.at(-1);
  return (
    <div
      className="drawer-shell"
      role="dialog"
      aria-modal="true"
      aria-label="Run detail"
    >
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
                {run.loopPaused && <PausedMark />}
              </p>
            )}
          </div>
          <button
            className="close-button"
            onClick={close}
            type="button"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        {detail.isError && (
          <p className="error-panel">{detail.error.message}</p>
        )}
        {run !== undefined && (
          <>
            <div className="run-summary">
              <StatusMark state={run.state} />
              <span className="annotation">{run.agent}</span>
              <span className="annotation">
                {run.attempts.length} attempt
                {run.attempts.length === 1 ? "" : "s"}
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
            {mutation.isError && (
              <p className="error-panel">{mutation.error.message}</p>
            )}
            <section className="drawer-section">
              <h3>Task</h3>
              <p>{run.task}</p>
            </section>
            <section className="drawer-section">
              <h3>Event</h3>
              <p className="annotation event-key">
                {detail.data?.eventDedupKey}
              </p>
              <pre className="payload-gist">
                {jsonGist(detail.data?.eventPayload ?? null)}
              </pre>
            </section>
            <section className="drawer-section">
              <h3>Attempts</h3>
              <div className="attempt-list">
                {run.attempts.length === 0 && (
                  <p className="empty-copy">No attempt has started.</p>
                )}
                {run.attempts.map((attempt) => (
                  <article className="attempt-entry" key={attempt.id}>
                    <header>
                      <strong>Attempt {attempt.number}</strong>
                      <StatusMark state={attempt.outcome?._tag ?? "Running"} />
                    </header>
                    <p className="annotation attempt-meta">
                      {attempt.worker} · {brainLine(attempt.brain)} ·{" "}
                      {timeAgo(attempt.startedAt)}
                    </p>
                    {attempt.outcome?._tag === "Failed" && (
                      <p className="attempt-error">
                        <strong>{attempt.outcome.failure._tag}</strong>
                        {` — ${failureMessage(attempt.outcome.failure)}`}
                      </p>
                    )}
                  </article>
                ))}
              </div>
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
              {earlier !== undefined && (
                <ActionButton
                  className="load-earlier"
                  disabled={earlierMutation.isPending}
                  onClick={() => earlierMutation.mutate(earlier)}
                >
                  {earlierMutation.isPending ? "Loading…" : "Load earlier"}
                </ActionButton>
              )}
              {earlierMutation.isError && (
                <p className="error-panel">{earlierMutation.error.message}</p>
              )}
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
  const openRun = (runId: Run.RunId) => navigate({ search: { run: runId } });
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
        {/* The indicator reports the trigger streams, not the server: idle
            pollers must never read as a running factory. */}
        <div
          className={`live-indicator ${data._tag === "NeedsSetup" ? "idle" : ""}`}
        >
          <i /> {data._tag === "NeedsSetup" ? "idle" : "live"}
        </div>
      </header>
      {data._tag === "NeedsSetup" && (
        <section className="setup-banner">
          <p className="eyebrow">Setup required · {data.errorTag}</p>
          <h1>The floor is ready. GitHub is not connected yet.</h1>
          <p>
            Add <code>USINE_GITHUB_APP_ID</code> and{" "}
            <code>USINE_GITHUB_PRIVATE_KEY</code>, or create{" "}
            <code>.usine/github-app.json</code> with mode 0600. Then stop and
            rerun <code>usine up</code>: the running process reads credentials
            only when it starts.
          </p>
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
            <span className="annotation">
              {data.projects.length} registered
            </span>
          </header>
          <div className="projects-list">
            {data.projects.map((project) => (
              <article className="project" key={project.repository}>
                <header>
                  <div>
                    <h2>{project.repository}</h2>
                    <p className="annotation">
                      {project.runs.length} recorded run
                      {project.runs.length === 1 ? "" : "s"}
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
                    {project.runs.map((run) => (
                      <RunRow
                        key={run.id}
                        run={run}
                        open={() => openRun(run.id)}
                      />
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
          <p className="aside-copy">
            Runtime controls. Authored loop files remain untouched.
          </p>
          <div className="loop-list">
            {data.loops.map((loop) => (
              <LoopCard
                key={loop.name}
                loop={loop}
                pending={pauseMutation.isPending || data._tag === "NeedsSetup"}
                act={(value) => pauseMutation.mutate(value)}
              />
            ))}
          </div>
          {pauseMutation.isError && (
            <p className="error-panel">{pauseMutation.error.message}</p>
          )}
        </aside>
      </main>
      {search.run !== undefined && (
        <RunDrawer runId={search.run} close={closeRun} />
      )}
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
