import {
  ArrowRightIcon,
  PauseIcon,
  PlayIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
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
  Link,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { Repository, Run } from "@usine/core";
import { FactoryOverview } from "@usine/orchestrator";
import type { LoopView, NeedView, ProjectView } from "@usine/orchestrator";
import { Schema } from "effect";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "@/components/app-sidebar";
import { ErrorAlert } from "@/components/error-alert";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { ProjectBoard } from "./board.tsx";
import { ApiOk } from "./api.ts";
import { needCopy } from "./operator-copy.ts";
import { RunDrawer } from "./run-drawer.tsx";
import "./index.css";

const FactorySearch = Schema.toStandardSchemaV1(
  Schema.Struct({
    run: Schema.optional(Run.RunId),
    project: Schema.optional(Repository.Name),
    view: Schema.optional(Schema.Literal("configuration")),
  }),
);
const ACTIVE_OVERVIEW_REFRESH_MS = 2_000;
const IDLE_OVERVIEW_REFRESH_MS = 15_000;

interface ContextSearch {
  project?: Repository.Name;
  view?: "configuration";
}

const overviewQuery = () => ({
  queryKey: ["overview"] as const,
  queryFn: () => api("/api/overview", FactoryOverview),
  refetchInterval: (
    query: Query<FactoryOverview, Error, FactoryOverview, readonly ["overview"]>,
  ) => {
    const overview = query.state.data;
    if (overview?._tag === "NeedsSetup") return false;
    const hasOpenRun = overview?.projects.some((project) =>
      project.runs.some(({ canCancel }) => canCancel),
    );
    return hasOpenRun === true ? ACTIVE_OVERVIEW_REFRESH_MS : IDLE_OVERVIEW_REFRESH_MS;
  },
});

const BootScreen = ({
  title,
  description,
  tone = "loading",
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone?: "loading" | "error";
  readonly children?: ReactNode;
}) => (
  <main className="grid min-h-svh place-items-center p-6">
    <Empty className="max-w-md">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={cn(tone === "error" && "text-destructive")}>
          {tone === "loading" ? <Spinner /> : <WarningCircleIcon weight="fill" />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="wrap-anywhere">{description}</EmptyDescription>
      </EmptyHeader>
      {children !== undefined && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  </main>
);

const NeedStrip = ({
  needs,
  openRun,
}: {
  readonly needs: ReadonlyArray<NeedView>;
  readonly openRun: (runId: Run.RunId) => void;
}) => (
  <section aria-label="Items needing intervention" className="border-b px-4 py-3 sm:px-6">
    <div className="flex items-center gap-2">
      <h2 className="font-heading text-sm font-medium">Needs you</h2>
      {needs.length > 0 ? (
        <Badge className="bg-needs-you font-mono text-background">{needs.length}</Badge>
      ) : (
        <p className="text-muted-foreground">No item needs intervention.</p>
      )}
    </div>
    {needs.length > 0 && (
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {needs.map((need) => {
          const copy = needCopy(need);
          const runId = copy.runId;
          const body = (
            <>
              <ItemContent>
                <ItemTitle className="line-clamp-1">{copy.title}</ItemTitle>
                <ItemDescription className="line-clamp-3 wrap-anywhere">
                  {copy.detail}
                </ItemDescription>
              </ItemContent>
              {copy.repository !== null && (
                <ItemFooter className="font-mono text-[0.625rem] text-muted-foreground">
                  {copy.repository}
                </ItemFooter>
              )}
            </>
          );
          return runId !== null ? (
            <Item
              key={need.id}
              variant="outline"
              size="sm"
              className="w-80 shrink-0 cursor-pointer text-left hover:bg-muted"
              render={<button type="button" onClick={() => openRun(runId)} />}
            >
              {body}
            </Item>
          ) : (
            <Item key={need.id} variant="muted" size="sm" className="w-80 shrink-0">
              {body}
            </Item>
          );
        })}
      </div>
    )}
  </section>
);

const ProjectIndex = ({
  projects,
  open,
}: {
  readonly projects: ReadonlyArray<ProjectView>;
  readonly open: (repository: Repository.Name) => void;
}) => (
  <main className="flex flex-col gap-4 p-4 sm:p-6">
    <Card className="max-w-5xl">
      <CardHeader>
        <CardTitle>Projects</CardTitle>
        <CardDescription>
          {projects.length} registered repositor{projects.length === 1 ? "y" : "ies"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No project registered</EmptyTitle>
              <EmptyDescription>
                Add a repository under <code>repos</code> in <code>usine.yaml</code> and restart{" "}
                <code>usine up</code>.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Lanes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const itemCount = project.board.lanes.reduce(
                  (total, lane) => total + lane.items.length,
                  0,
                );
                const needsYou = project.board.lanes.reduce(
                  (total, lane) => total + lane.items.filter((item) => item.needsYou).length,
                  0,
                );
                return (
                  <TableRow
                    key={project.repository}
                    className="cursor-pointer"
                    onClick={() => open(project.repository)}
                  >
                    <TableCell className="font-mono font-medium">{project.repository}</TableCell>
                    <TableCell className="text-right tabular-nums">{itemCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {project.board.lanes.length}
                    </TableCell>
                    <TableCell>
                      {project.status === "needs-you" ? (
                        <NeedsYouBadge count={needsYou} />
                      ) : (
                        <StatusBadge state={project.status} />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Open ${project.repository}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          open(project.repository);
                        }}
                      >
                        <ArrowRightIcon aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  </main>
);

const Configuration = ({
  loops,
  pending,
  act,
  error,
}: {
  readonly loops: ReadonlyArray<LoopView>;
  readonly pending: boolean;
  readonly act: (loop: LoopView) => void;
  readonly error: string | null;
}) => (
  <main className="flex flex-col gap-4 p-4 sm:p-6">
    <Card className="max-w-5xl">
      <CardHeader>
        <CardTitle>Loops</CardTitle>
        <CardDescription>
          {loops.length} loop{loops.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Loop</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loops.map((loop) => (
              <TableRow key={loop.name}>
                <TableCell className="font-mono font-medium">{loop.name}</TableCell>
                <TableCell className="font-mono">{loop.trigger}</TableCell>
                <TableCell className="font-mono">{loop.agent}</TableCell>
                <TableCell>
                  <Badge variant="outline">{loop.paused ? "paused" : "active"}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant={loop.paused ? "default" : "outline"}
                    size="sm"
                    disabled={pending}
                    onClick={() => act(loop)}
                  >
                    {loop.paused ? (
                      <PlayIcon data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <PauseIcon data-icon="inline-start" aria-hidden="true" />
                    )}
                    {loop.paused ? "Unpause" : "Pause"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    {error !== null && <ErrorAlert className="max-w-5xl" message={error} />}
  </main>
);

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
  const contextSearch: ContextSearch = {};
  if (search.project !== undefined) contextSearch.project = search.project;
  if (search.view !== undefined) contextSearch.view = search.view;
  const openRun = (runId: Run.RunId) => navigate({ search: { ...contextSearch, run: runId } });
  const closeRun = () => navigate({ search: contextSearch });

  if (overview.isPending) return <BootScreen title="Usine" description="Loading…" />;
  if (overview.isError)
    return (
      <BootScreen title="Server unreachable" description={overview.error.message} tone="error" />
    );
  const data = overview.data;
  const live = data._tag !== "NeedsSetup";
  return (
    <SidebarProvider>
      <AppSidebar
        projects={data.projects}
        view={search.view ?? "projects"}
        project={search.project}
        needsYou={data.needsYou.length}
        live={live}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <Breadcrumb>
            <BreadcrumbList>
              {search.view === "configuration" ? (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/" search={{ view: "configuration" }} />}>
                      Configuration
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Loops</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : search.project === undefined ? (
                <BreadcrumbItem>
                  <BreadcrumbPage>Projects</BreadcrumbPage>
                </BreadcrumbItem>
              ) : (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/" search={{}} />}>Projects</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="font-mono">{search.project}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        {data._tag === "NeedsSetup" && (
          <Alert className="rounded-none border-x-0 border-t-0 bg-transparent px-4 py-4 sm:px-6">
            <WarningIcon weight="fill" className="text-needs-you" />
            <AlertTitle className="text-sm">GitHub App credentials are missing</AlertTitle>
            <AlertDescription className="max-w-prose">
              <p>
                {data.errorTag}. Set <code>USINE_GITHUB_APP_ID</code> and{" "}
                <code>USINE_GITHUB_PRIVATE_KEY</code>, or create <code>.usine/github-app.json</code>{" "}
                with mode 0600, then restart <code>usine up</code>. Credentials are read at startup
                only.
              </p>
            </AlertDescription>
          </Alert>
        )}
        <NeedStrip needs={data.needsYou} openRun={openRun} />
        {search.view === "configuration" ? (
          <Configuration
            loops={data.loops}
            pending={pauseMutation.isPending || data._tag === "NeedsSetup"}
            act={(value) => pauseMutation.mutate(value)}
            error={pauseMutation.isError ? pauseMutation.error.message : null}
          />
        ) : search.project === undefined ? (
          <ProjectIndex
            projects={data.projects}
            open={(project) => navigate({ search: { project } })}
          />
        ) : (
          (() => {
            const project = data.projects.find(({ repository }) => repository === search.project);
            return project === undefined ? (
              <BootScreen
                title="Project not found"
                description={`${search.project} is not a registered project.`}
                tone="error"
              >
                <Button variant="outline" onClick={() => navigate({ search: {} })}>
                  Back to projects
                </Button>
              </BootScreen>
            ) : (
              <ProjectBoard
                project={project}
                disabled={data._tag === "NeedsSetup"}
                openRun={openRun}
              />
            );
          })()
        )}
        {search.run !== undefined && <RunDrawer runId={search.run} close={closeRun} />}
      </SidebarInset>
    </SidebarProvider>
  );
};

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: FactorySearch,
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
