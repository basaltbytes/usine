import { WarningIcon } from "@phosphor-icons/react";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Schema } from "effect";
import { AppSidebar } from "@/components/app-sidebar";
import { BootScreen } from "@/components/boot-screen";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { NeedsYou } from "../needs-you/needs-you.tsx";
import { needsYouByProject, overviewQuery } from "../overview.ts";
import { Suspense, lazy, useState } from "react";

// The drawer bundles the transcript, Markdown, and message components, so it
// loads on first open to keep a project's first paint small.
const RunDrawer = lazy(() =>
  import("../run-drawer.tsx").then(({ RunDrawer: drawer }) => ({ default: drawer })),
);

/** The run drawer overlays any screen, so its run id is kept in the root search. */
const RootSearch = Schema.toStandardSchemaV1(Schema.Struct({ run: Schema.optional(RunId) }));

interface RouterContext {
  readonly queryClient: QueryClient;
}

const Unreachable = ({ error }: { readonly error: Error }) => {
  const router = useRouter();
  return (
    <BootScreen title="Server unreachable" description={error.message} tone="error">
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </BootScreen>
  );
};

const Crumbs = ({ project }: { readonly project: RepositoryName | undefined }) => {
  const matchRoute = useMatchRoute();
  const configuration = matchRoute({ to: "/configuration/loops" }) !== false;
  if (configuration)
    return (
      <>
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link to="/configuration/loops" />}>Configuration</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Loops</BreadcrumbPage>
        </BreadcrumbItem>
      </>
    );
  if (project === undefined)
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>Projects</BreadcrumbPage>
      </BreadcrumbItem>
    );
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink render={<Link to="/" />}>Projects</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{project}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );
};

const Shell = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const { run } = Route.useSearch();
  // Plain useNavigate resolves "." against the current route; Route.useNavigate would pin it to "/".
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const matchRoute = useMatchRoute();
  const project = params.repository;
  const view = matchRoute({ to: "/configuration/loops" }) === false ? "projects" : "configuration";
  const closeRun = () => void navigate({ to: ".", search: ({ run: _run, ...rest }) => rest });
  // Remember the last opened Run so the Sheet stays mounted for its exit transition.
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
        live={live}
      />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              <Crumbs project={project} />
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {data._tag === "NeedsSetup" && (
            <Alert className="rounded-none border-x-0 border-t-0 bg-transparent px-4 py-4 md:px-5">
              <WarningIcon weight="fill" className="text-needs-you" />
              <AlertTitle className="text-md">GitHub App credentials are missing</AlertTitle>
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
          <NeedsYou needs={data.needsYou} />
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
