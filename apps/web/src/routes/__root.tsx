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
import type { NeedView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { AppSidebar } from "@/components/app-sidebar";
import { BootScreen } from "@/components/boot-screen";
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
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { needCopy } from "../operator-copy.ts";
import { overviewQuery } from "../overview.ts";
import { Suspense, lazy, useState } from "react";
import { useOpenRun } from "../open-run.ts";

// The drawer carries the transcript, Markdown, and message components; it
// loads on first open so the first paint of a project stays small (#81).
const RunDrawer = lazy(() =>
  import("../run-drawer.tsx").then(({ RunDrawer: drawer }) => ({ default: drawer })),
);

/** The run drawer overlays any screen, so its id lives in the root search. */
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

const NeedStrip = ({ needs }: { readonly needs: ReadonlyArray<NeedView> }) => {
  const openRun = useOpenRun();
  return (
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
        <BreadcrumbPage className="font-mono">{project}</BreadcrumbPage>
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
              <Crumbs project={project} />
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
        <NeedStrip needs={data.needsYou} />
        <Outlet />
        {shownRun !== undefined && (
          <Suspense fallback={null}>
            <RunDrawer runId={shownRun} open={run !== undefined} close={closeRun} />
          </Suspense>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: RootSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery()),
  pendingComponent: () => <BootScreen title="Usine" description="Loading…" />,
  errorComponent: Unreachable,
  component: Shell,
});
