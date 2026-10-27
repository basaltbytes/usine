import { WarningIcon } from "@phosphor-icons/react";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { FactoryOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { AppSidebar, type OperatorView, useOperatorView } from "~/components/app-sidebar";
import { BootScreen } from "~/components/boot-screen";
import { cardIdentity } from "~/components/item/identity";
import { itemLabel } from "~/components/item/mark";
import { RepositoryMark } from "~/components/repository-mark";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { ConfigurationCrumbs } from "~/features/configuration/configuration.page";
import { NeedsYou } from "~/components/needs-you/needs-you";
import { rejectionMessage } from "~/lib/api";
import { needsYouByProject, overviewQuery, projectParams } from "~/lib/overview";
import { Suspense, lazy, useState } from "react";

// Loaded on first open; it includes the transcript, Markdown, and message components.
const RunDrawer = lazy(() =>
  import("~/components/runs/drawer").then(({ RunDrawer: drawer }) => ({ default: drawer })),
);

/** `run` is in the root search so the Run drawer can open over any route. */
const RootSearch = Schema.toStandardSchemaV1(Schema.Struct({ run: Schema.optional(RunId) }));

interface RouterContext {
  readonly queryClient: QueryClient;
}

const Unreachable = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  return (
    <BootScreen title="Server unreachable" description={rejectionMessage(error)} tone="error">
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </BootScreen>
  );
};

/** Returns the name of the Task with the item `number`: its originating item, else the item. */
const taskCrumb = (overview: FactoryOverview, repository: RepositoryName, number: string) => {
  const card = overview.projects
    .find((project) => project.repository === repository)
    ?.board.lanes.flatMap(({ items }) => items)
    .find(({ items }) => items.some((member) => String(member.number) === number));
  return card === undefined
    ? `Item #${number}`
    : itemLabel({ ...cardIdentity(card).origin, state: null });
};

const Crumbs = ({
  view,
  project,
  runId,
  task,
}: {
  readonly view: OperatorView;
  readonly project: RepositoryName | undefined;
  readonly runId: RunId | undefined;
  /** The open Task page's originating item, such as `Issue #481`. */
  readonly task: string | undefined;
}) => {
  if (view === "configuration") return <ConfigurationCrumbs />;
  if (project === undefined)
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>Overview</BreadcrumbPage>
      </BreadcrumbItem>
    );
  return (
    <>
      <BreadcrumbItem>
        {view === "board" ? (
          <BreadcrumbPage className="flex items-center gap-1.5">
            <RepositoryMark repository={project} />
            {project}
          </BreadcrumbPage>
        ) : (
          <BreadcrumbLink
            className="flex items-center gap-1.5"
            render={<Link to="/projects/$owner/$name" params={projectParams(project)} />}
          >
            <RepositoryMark repository={project} />
            {project}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {view === "tasks" && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {task === undefined ? (
              <BreadcrumbPage>Tasks</BreadcrumbPage>
            ) : (
              <BreadcrumbLink
                render={<Link to="/projects/$owner/$name/tasks" params={projectParams(project)} />}
              >
                Tasks
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
        </>
      )}
      {runId !== undefined && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              Run <span className="font-mono text-xs">{runId.slice(0, 8)}</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </>
      )}
      {task !== undefined && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{task}</BreadcrumbPage>
          </BreadcrumbItem>
        </>
      )}
    </>
  );
};

const Shell = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const { run } = Route.useSearch();
  // Plain useNavigate resolves "." against the current route; Route.useNavigate would pin it to "/".
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const project = params.repository;
  const view = useOperatorView();
  const closeRun = () => void navigate({ to: ".", search: ({ run: _run, ...rest }) => rest });
  // Keeps the last opened Run so the Sheet stays mounted during its exit transition.
  const [shownRun, setShownRun] = useState(run);
  if (run !== undefined && run !== shownRun) setShownRun(run);
  const live = data._tag !== "NeedsSetup";
  return (
    <SidebarProvider>
      <AppSidebar
        projects={data.projects}
        view={view}
        project={project}
        needsYou={needsYouByProject(data.needsYou)}
        needsYouTotal={data.needsYou.length}
        live={live}
      />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              <Crumbs
                view={view}
                project={project}
                runId={params.run}
                task={
                  project === undefined || params.number === undefined
                    ? undefined
                    : taskCrumb(data, project, params.number)
                }
              />
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {data._tag === "NeedsSetup" && (
            <Alert className="rounded-none border-x-0 border-t-0 bg-transparent px-4 py-4 md:px-5">
              <WarningIcon weight="fill" className="text-needs-you" />
              <AlertTitle className="text-md">GitHub App not set up</AlertTitle>
              <AlertDescription className="max-w-prose">
                <p>
                  {data.errorTag}. Set <code>USINE_GITHUB_APP_ID</code> and{" "}
                  <code>USINE_GITHUB_PRIVATE_KEY</code>, or create{" "}
                  <code>.usine/github-app.json</code> with mode 0600, then restart{" "}
                  <code>usine up</code>. Credentials are read at startup only.
                </p>
              </AlertDescription>
            </Alert>
          )}
          {/* The Overview page renders Needs attention itself. */}
          {view !== "desk" && <NeedsYou needs={data.needsYou} compact={params.run !== undefined} />}
          <Outlet />
        </div>
        {shownRun !== undefined && (
          <Suspense fallback={null}>
            <RunDrawer key={shownRun} runId={shownRun} open={run !== undefined} close={closeRun} />
          </Suspense>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: RootSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery()),
  pendingComponent: () => <BootScreen title="usine" description="Loading…" />,
  errorComponent: Unreachable,
  component: Shell,
});
