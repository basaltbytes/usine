import { Link, useMatchRoute } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type { ProjectView } from "@usine/orchestrator/operator";
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
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ConfigurationMenu } from "../configuration/layout.tsx";
import { projectParams } from "../overview.ts";

/** What the work panel shows: Overview, a Project's Board, its Tasks list or one of its Task
 * pages, another page of a Project such as a Run page, or the Configuration section. */
export type OperatorView = "desk" | "board" | "tasks" | "project" | "configuration";

/** The page the work panel shows, from the matched route. */
export const useOperatorView = (): OperatorView => {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/configuration", fuzzy: true }) !== false) return "configuration";
  if (matchRoute({ to: "/" }) !== false) return "desk";
  if (matchRoute({ to: "/projects/$owner/$name/tasks", fuzzy: true }) !== false) return "tasks";
  if (matchRoute({ to: "/projects/$owner/$name" }) !== false) return "board";
  return "project";
};

export const AppSidebar = ({
  projects,
  view,
  project,
  needsYou,
  needsYouTotal,
  live,
}: {
  readonly projects: ReadonlyArray<ProjectView>;
  readonly view: OperatorView;
  readonly project: RepositoryName | undefined;
  /** How many Needs you entries concern each Project. */
  readonly needsYou: ReadonlyMap<RepositoryName, number>;
  /** How many Needs you entries there are in all, including those about no Project. */
  readonly needsYouTotal: number;
  readonly live: boolean;
}) => (
  <Sidebar variant="inset">
    <SidebarHeader className="px-2 pt-2 pb-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/" />}
            className="text-md font-semibold tracking-tight text-foreground"
          >
            usine
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
                <span>Overview</span>
              </SidebarMenuButton>
              {needsYouTotal > 0 && (
                <SidebarMenuBadge className="text-needs-you peer-data-active/menu-button:text-needs-you">
                  {needsYouTotal}
                  <span className="sr-only"> need attention</span>
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="pt-3">
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {projects.map((entry) => {
              const count = needsYou.get(entry.repository) ?? 0;
              const params = projectParams(entry.repository);
              const current = project === entry.repository;
              return (
                <SidebarMenuItem key={entry.repository}>
                  {/* Board or Tasks is the active row on their pages; the Project's own row is
                      active on its other pages, such as a Run page. */}
                  <SidebarMenuButton
                    isActive={current && view === "project"}
                    className={cn(count > 0 && "pr-8")}
                    render={<Link to="/projects/$owner/$name" params={params} />}
                  >
                    <span>{entry.repository}</span>
                  </SidebarMenuButton>
                  {count > 0 && (
                    <SidebarMenuBadge className="text-needs-you peer-data-active/menu-button:text-needs-you">
                      {count}
                      <span className="sr-only"> need attention</span>
                    </SidebarMenuBadge>
                  )}
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={current && view === "board"}
                        render={<Link to="/projects/$owner/$name" params={params} />}
                      >
                        <span>Board</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={current && view === "tasks"}
                        render={<Link to="/projects/$owner/$name/tasks" params={params} />}
                      >
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
      <SidebarGroup className="pt-3">
        <SidebarGroupLabel>Configuration</SidebarGroupLabel>
        <SidebarGroupContent>
          <ConfigurationMenu inSection={view === "configuration"} />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-4 pb-3">
      {/* Reports the trigger streams, not the server: idle pollers must never read as a running factory. */}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", live ? "bg-run-succeeded" : "bg-faint")}
        />
        {live ? "live" : "idle"}
      </p>
    </SidebarFooter>
  </Sidebar>
);
