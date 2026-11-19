import { connectChanges } from "~/lib/changes";
import { MemberShell } from "~/components/member-shell";
import { canReadOverview, sessionQuery } from "~/lib/permissions";
import { CommandPalette } from "~/components/command-palette/palette";
import { PageCommandsProvider, PageCommandsScope } from "~/components/command-palette/context";
import { RefreshProvider } from "~/components/refresh/provider";
import { membersLabel, tokensPageLabel } from "~/lib/strings";
import { ChatsCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { ConversationId } from "@usine/core/conversation";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenConversation } from "~/hooks/use-open-conversation";
import {
  conversationQuery,
  conversationsQuery,
  conversationStatusQuery,
  unreadCount,
} from "~/lib/conversations/queries";
import {
  conversationsTitle,
  openConversationsLabel,
  openConversationsWithUnread,
} from "~/lib/conversations/strings";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useMatchRoute,
  useParams,
  useSearch,
  useRouter,
} from "@tanstack/react-router";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { FactoryOverview, ProjectView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { Suspense, lazy, useEffect, useState } from "react";
import { runDetailQuery } from "~/lib/runs/queries";
import { AppSidebar, type OperatorView, useOperatorView } from "~/components/app-sidebar";
import { BootScreen } from "~/components/boot-screen";
import { cardIdentity } from "~/components/item/identity";
import { itemLabel } from "~/components/item/mark";
import { RepositoryMark } from "~/components/repository-mark";
import { TextTooltipProvider } from "~/components/text-tooltip";
import { Toaster } from "~/components/ui/toast";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { ConfigurationCrumbs } from "~/components/configuration/navigation";
import { NotificationTray } from "~/components/needs-you/notification-tray";
import { rejectionMessage } from "~/lib/api";
import {
  attentionQuery,
  needsYouByProject,
  overviewQuery,
  projectId,
  projectName,
  projectForRepository,
} from "~/lib/overview";

// Loaded on first open; it includes the transcript, Markdown, and message components.
const RunDrawer = lazy(() =>
  import("~/components/runs/drawer").then(({ RunDrawer: drawer }) => ({ default: drawer })),
);

// Loaded on first open, like the Run drawer.
const ConversationPanel = lazy(() =>
  import("~/components/conversations/panel").then(({ ConversationPanel: panel }) => ({
    default: panel,
  })),
);

/**
 * `run` and `conversation` are in the root search so the Run drawer and the supervisor inbox can
 * open over any route. `conversation` is a conversation ID, `new` for the form that starts one,
 * or `inbox` for the list with nothing open.
 */
const RootSearch = Schema.toStandardSchemaV1(
  Schema.Struct({
    run: Schema.optional(RunId),
    conversation: Schema.optional(
      Schema.Union([Schema.Literals(["inbox", "new"]), ConversationId]),
    ),
  }),
);

/** The header control that opens the supervisor inbox, with the member's unread count. */
const InboxButton = () => {
  const openConversation = useOpenConversation();
  const { data: unread = 0 } = useQuery({ ...conversationsQuery(), select: unreadCount });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="toolbar"
            variant="ghost"
            className="relative h-9 shrink-0 pointer-coarse:h-11 pointer-coarse:min-w-11"
            aria-label={openConversationsWithUnread(unread)}
            onClick={() => openConversation("inbox")}
          />
        }
      >
        <ChatsCircleIcon aria-hidden="true" className="size-4" />
        {unread > 0 && (
          // Over the icon's corner, so the count appearing shifts nothing in the header.
          <Badge
            variant="counter"
            className="pointer-events-none absolute top-0.5 right-0 h-4 min-w-4"
          >
            {unread}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{openConversationsLabel}</TooltipContent>
    </Tooltip>
  );
};

interface RouterContext {
  readonly queryClient: QueryClient;
}

type UnreachableProps = Readonly<ErrorComponentProps>;

const Unreachable = ({ error }: UnreachableProps) => {
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
  const card = [
    ...overview.identities,
    ...(projectForRepository(overview.projects, repository)?.board.lanes.flatMap(
      ({ items }) => items,
    ) ?? []),
  ].find(
    (card) =>
      canonicalRepositoryName(card.repository) === canonicalRepositoryName(repository) &&
      card.items.some((member) => String(member.number) === number),
  );
  return card === undefined
    ? `Item #${number}`
    : itemLabel({ ...cardIdentity(card).origin, state: null });
};

type CrumbsProps = {
  readonly view: OperatorView;
  readonly project: ProjectView | undefined;
  readonly runId: RunId | undefined;
  /** The open Task page's originating item, such as `Issue #481`. */
  readonly task: string | undefined;
};

const Crumbs = ({ view, project, runId, task }: CrumbsProps) => {
  if (view === "members" || view === "tokens")
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>{view === "members" ? membersLabel : tokensPageLabel}</BreadcrumbPage>
      </BreadcrumbItem>
    );
  if (view === "configuration") return <ConfigurationCrumbs />;
  if (view === "conversations")
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>{conversationsTitle}</BreadcrumbPage>
      </BreadcrumbItem>
    );
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
          <BreadcrumbPage variant="icon" className="flex items-center">
            <RepositoryMark repository={project.repository} />
            {projectName(project)}
          </BreadcrumbPage>
        ) : (
          <BreadcrumbLink
            variant="icon"
            className="flex items-center"
            render={<Link to="/projects/$project" params={{ project: projectId(project) }} />}
          >
            <RepositoryMark repository={project.repository} />
            {projectName(project)}
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
                render={
                  <Link to="/projects/$project/tasks" params={{ project: projectId(project) }} />
                }
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
  const queryClient = useQueryClient();
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Subscribe the query cache to server change events.
  useEffect(() => connectChanges(queryClient), [queryClient]);
  const { data } = useSuspenseQuery(overviewQuery());
  const { data: needs } = useSuspenseQuery({
    ...attentionQuery(),
    select: (view) => view.needsYou,
  });
  const { run, conversation } = Route.useSearch();
  // Plain useNavigate resolves "." against the current route; Route.useNavigate would pin it to "/".
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const repository =
    params.name === undefined || params.project === undefined
      ? search.repository
      : RepositoryName.make(`${params.project}/${params.name}`);
  const project =
    data.projects.find((entry) => projectId(entry) === params.project) ??
    (repository === undefined ? undefined : projectForRepository(data.projects, repository));
  const view = useOperatorView();
  const closeRun = () => void navigate({ to: ".", search: ({ run: _run, ...rest }) => rest });
  // Keeps the last opened Run so the Sheet stays mounted during its exit transition.
  const [shownRun, setShownRun] = useState(run);
  if (run !== undefined && run !== shownRun) setShownRun(run);
  const closeConversation = () =>
    void navigate({ to: ".", search: ({ conversation: _conversation, ...rest }) => rest });
  // The conversations page shows the inbox itself, so the search param opens no sheet there.
  const inboxPage = view === "conversations";
  const [shownConversation, setShownConversation] = useState(conversation);
  if (conversation !== undefined && conversation !== shownConversation)
    setShownConversation(conversation);
  const live = data._tag !== "NeedsSetup";
  return (
    <Toaster>
      <SidebarProvider>
        <AppSidebar
          projects={data.projects}
          view={view}
          project={project === undefined ? undefined : projectId(project)}
          needsYou={needsYouByProject(needs, data.projects)}
          needsYouTotal={needs.length}
          runningTotal={
            new Set(
              data.projects.flatMap(({ runs }) =>
                (runs ?? []).filter(({ state }) => state === "Running").map(({ id }) => id),
              ),
            ).size
          }
          live={live}
        />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <PageCommandsProvider>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
              <SidebarTrigger tone="muted" />
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList>
                  <Crumbs
                    view={view}
                    project={project}
                    runId={params.run === undefined ? undefined : RunId.make(params.run)}
                    task={
                      project === undefined || params.number === undefined
                        ? undefined
                        : taskCrumb(data, repository ?? project.repository, params.number)
                    }
                  />
                </BreadcrumbList>
              </Breadcrumb>
              <CommandPalette overview={data} />
              <InboxButton />
              <NotificationTray needs={needs} />
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {data._tag === "NeedsSetup" && (
                <Alert variant="banner">
                  <WarningIcon weight="fill" className="text-needs-you" />
                  <AlertTitle size="lg">GitHub App not set up</AlertTitle>
                  <AlertDescription className="max-w-prose">
                    <p>
                      <a href="/setup" className="underline underline-offset-4">
                        Finish GitHub App setup
                      </a>{" "}
                      to connect this instance.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              <PageCommandsScope
                active={run === undefined && (conversation === undefined || inboxPage)}
              >
                <RefreshProvider>
                  <Outlet />
                </RefreshProvider>
              </PageCommandsScope>
            </div>
            <PageCommandsScope active={run !== undefined}>
              {shownRun !== undefined && (
                <Suspense fallback={null}>
                  <RunDrawer
                    key={shownRun}
                    runId={shownRun}
                    open={run !== undefined}
                    close={closeRun}
                  />
                </Suspense>
              )}
            </PageCommandsScope>
            {shownConversation !== undefined && !inboxPage && (
              <Suspense fallback={null}>
                <ConversationPanel
                  target={shownConversation}
                  open={conversation !== undefined}
                  close={closeConversation}
                  project={project === undefined ? undefined : projectId(project)}
                />
              </Suspense>
            )}
          </PageCommandsProvider>
        </SidebarInset>
      </SidebarProvider>
    </Toaster>
  );
};

const Root = () => {
  const matchRoute = useMatchRoute();
  return (
    <TextTooltipProvider>
      {matchRoute({ to: "/sign-in" }) !== false || matchRoute({ to: "/setup" }) !== false ? (
        <Outlet />
      ) : (
        <MemberShell>
          <Shell />
        </MemberShell>
      )}
    </TextTooltipProvider>
  );
};

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: RootSearch,
  loaderDeps: ({ search }) => ({ run: search.run, conversation: search.conversation }),
  loader: async ({ context: { queryClient }, deps: { run, conversation }, location }) => {
    if (location.pathname === "/sign-in" || location.pathname === "/setup") return;
    const session = await queryClient.ensureQueryData(sessionQuery());
    if (!canReadOverview(session.permissions)) return;
    // Starts the header's unread count early without holding the page for it.
    void queryClient.prefetchQuery(conversationsQuery());
    await Promise.all([
      queryClient.ensureQueryData(overviewQuery()),
      queryClient.ensureQueryData(attentionQuery()),
      // A rejected drawer query is displayed inside the drawer.
      Promise.allSettled(
        run === undefined ? [] : [queryClient.ensureQueryData(runDetailQuery(queryClient, run))],
      ),
      // A rejected conversation query is displayed inside the panel.
      Promise.allSettled(
        conversation === undefined
          ? []
          : [
              queryClient.ensureQueryData(conversationStatusQuery()),
              queryClient.ensureQueryData(conversationsQuery()),
              ...(conversation === "new" || conversation === "inbox"
                ? []
                : [queryClient.ensureQueryData(conversationQuery(conversation))]),
            ],
      ),
    ]);
  },
  pendingComponent: () => <BootScreen title="usine" description="Loading…" />,
  errorComponent: Unreachable,
  component: Root,
});
