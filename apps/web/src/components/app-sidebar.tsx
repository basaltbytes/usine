import { SessionMenu } from "~/components/session-menu";
import {
  ChatsCircleIcon,
  KanbanIcon,
  ListChecksIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import { conversationsTitle } from "~/lib/conversations/strings";
import { Link, useMatchRoute } from "@tanstack/react-router";
import type { ProjectId } from "@usine/core/project";
import type { ProjectView } from "@usine/orchestrator/operator";
import { RepositoryMark } from "~/components/repository-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "~/components/ui/sidebar";
import { UsineMark } from "~/components/usine-mark";
import { cn } from "~/lib/utils";
import { ConfigurationMenu } from "~/components/configuration/navigation";
import { projectId, projectName } from "~/lib/overview";
import { repositoryCountLabel } from "~/lib/strings";

/** `tasks` covers the Tasks list and Task pages; `project` covers other Project pages, such as a
 * Run page. */
export type OperatorView =
  | "desk"
  | "board"
  | "tasks"
  | "project"
  | "configuration"
  | "members"
  | "tokens"
  | "conversations";

export const useOperatorView = (): OperatorView => {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/conversations" }) !== false) return "conversations";
  if (matchRoute({ to: "/members" }) !== false) return "members";
  if (matchRoute({ to: "/tokens" }) !== false) return "tokens";
  if (matchRoute({ to: "/configuration", fuzzy: true }) !== false) return "configuration";
  if (matchRoute({ to: "/" }) !== false) return "desk";
  if (matchRoute({ to: "/projects/$project/tasks", fuzzy: true }) !== false) return "tasks";
  if (matchRoute({ to: "/projects/$project" }) !== false) return "board";
  return "project";
};

type AttentionCountProps = { readonly count: number };

const AttentionCount = ({ count }: AttentionCountProps) => (
  <SidebarMenuBadge variant="attention" className="right-2 min-w-0">
    {count}
    <span className="sr-only"> need attention</span>
  </SidebarMenuBadge>
);

type AppSidebarProps = {
  readonly projects: ReadonlyArray<ProjectView>;
  readonly view: OperatorView;
  readonly project: ProjectId | undefined;
  /** Needs you entry count per Project. */
  readonly needsYou: ReadonlyMap<ProjectId, number>;
  /** Total Needs you entries, including those without a Project. */
  readonly needsYouTotal: number;
  readonly runningTotal: number;
  readonly live: boolean;
};

export const AppSidebar = ({
  projects,
  view,
  project,
  needsYou,
  needsYouTotal,
  runningTotal,
  live,
}: AppSidebarProps) => (
  <Sidebar variant="inset">
    <SidebarHeader spacing="roomy">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton content="brand" render={<Link to="/" />}>
            {/* `align-middle` centers the mark on the x-height, and `-ml-px` on the icon column. */}
            <span className="-ml-px">
              <UsineMark className="mr-1.75 inline-block size-4.5! align-middle" />
              usine
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                content="summary"
                isActive={view === "desk"}
                render={<Link to="/" />}
              >
                <SquaresFourIcon aria-hidden="true" />
                <span>Overview</span>
              </SidebarMenuButton>
              <SidebarMenuBadge variant="summary" className="right-2">
                <span className="text-run-active">
                  {runningTotal}
                  <span className="sr-only"> running</span>
                </span>
                {needsYouTotal > 0 && (
                  <span className="text-needs-you">
                    {needsYouTotal}
                    <span className="sr-only"> need attention</span>
                  </span>
                )}
              </SidebarMenuBadge>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "conversations"}
                render={<Link to="/conversations" />}
              >
                <ChatsCircleIcon aria-hidden="true" />
                <span>{conversationsTitle}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup spacing="section">
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu spacing="relaxed">
            {projects.map((entry) => {
              const count = needsYou.get(projectId(entry)) ?? 0;
              const params = { project: projectId(entry) };
              const current = project === projectId(entry);
              return (
                <SidebarMenuItem key={projectId(entry)}>
                  {/* On Board and Tasks pages that row is active; on other Project pages, such as
                      a Run page, the Project row is active. */}
                  <SidebarMenuButton
                    content={count > 0 ? "action" : undefined}
                    isActive={current && view === "project"}
                    title={
                      entry.repositories.length > 1
                        ? repositoryCountLabel(entry.repositories.length)
                        : undefined
                    }
                    render={<Link to="/projects/$project" params={params} />}
                  >
                    <RepositoryMark repository={entry.repository} />
                    <span>{projectName(entry)}</span>
                  </SidebarMenuButton>
                  {count > 0 && <AttentionCount count={count} />}
                  {/* Sub-row icons line up with the project name, and fills span the full row. */}
                  <SidebarMenuSub variant="flat" className="mx-0 translate-x-0">
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        indent="icon"
                        isActive={current && view === "board"}
                        className="translate-x-0"
                        render={<Link to="/projects/$project" params={params} />}
                      >
                        <KanbanIcon aria-hidden="true" />
                        <span>Board</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        indent="icon"
                        isActive={current && view === "tasks"}
                        className="translate-x-0"
                        render={<Link to="/projects/$project/tasks" params={params} />}
                      >
                        <ListChecksIcon aria-hidden="true" />
                        <span>Tasks</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup spacing="section">
        <SidebarGroupLabel>Configuration</SidebarGroupLabel>
        <SidebarGroupContent>
          <ConfigurationMenu inSection={view === "configuration"} />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter spacing="roomy">
      <SessionMenu />
      {/* Shows trigger stream state, not server state, so idle pollers are not shown as running. */}
      <p className="flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="flex size-4 items-center justify-center">
          <span className={cn("size-1.5 rounded-full", live ? "bg-run-succeeded" : "bg-faint")} />
        </span>
        {live ? "Live" : "Idle"}
      </p>
    </SidebarFooter>
  </Sidebar>
);
