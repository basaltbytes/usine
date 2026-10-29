import { SessionMenu } from "~/components/session-menu";
import { KanbanIcon, ListChecksIcon, SquaresFourIcon } from "@phosphor-icons/react";
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
  | "tokens";

export const useOperatorView = (): OperatorView => {
  const matchRoute = useMatchRoute();
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
  <SidebarMenuBadge className="right-2 min-w-0 px-0 text-needs-you peer-hover/menu-button:text-needs-you peer-data-active/menu-button:text-needs-you">
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
  readonly live: boolean;
};

export const AppSidebar = ({
  projects,
  view,
  project,
  needsYou,
  needsYouTotal,
  live,
}: AppSidebarProps) => (
  <Sidebar variant="inset">
    <SidebarHeader className="px-2 pt-2 pb-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/" />}
            className="text-md font-semibold tracking-tight text-foreground"
          >
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
                isActive={view === "desk"}
                className={cn(needsYouTotal > 0 && "pr-8")}
                render={<Link to="/" />}
              >
                <SquaresFourIcon aria-hidden="true" />
                <span>Overview</span>
              </SidebarMenuButton>
              {needsYouTotal > 0 && <AttentionCount count={needsYouTotal} />}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="pt-4">
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu className="gap-1.5">
            {projects.map((entry) => {
              const count = needsYou.get(projectId(entry)) ?? 0;
              const params = { project: projectId(entry) };
              const current = project === projectId(entry);
              return (
                <SidebarMenuItem key={projectId(entry)}>
                  {/* On Board and Tasks pages that row is active; on other Project pages, such as
                      a Run page, the Project row is active. */}
                  <SidebarMenuButton
                    isActive={current && view === "project"}
                    title={
                      entry.repositories.length > 1
                        ? repositoryCountLabel(entry.repositories.length)
                        : undefined
                    }
                    className={cn(count > 0 && "pr-8")}
                    render={<Link to="/projects/$project" params={params} />}
                  >
                    <RepositoryMark repository={entry.repository} />
                    <span>{projectName(entry)}</span>
                  </SidebarMenuButton>
                  {count > 0 && <AttentionCount count={count} />}
                  {/* Sub-row icons line up with the project name, and fills span the full row. */}
                  <SidebarMenuSub className="mx-0 translate-x-0 gap-px border-l-0 px-0 py-px">
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={current && view === "board"}
                        className="translate-x-0 pl-8"
                        render={<Link to="/projects/$project" params={params} />}
                      >
                        <KanbanIcon aria-hidden="true" />
                        <span>Board</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={current && view === "tasks"}
                        className="translate-x-0 pl-8"
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
      <SidebarGroup className="pt-4">
        <SidebarGroupLabel>Configuration</SidebarGroupLabel>
        <SidebarGroupContent>
          <ConfigurationMenu inSection={view === "configuration"} />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-2 pb-3">
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
