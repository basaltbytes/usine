import { CircleIcon, KanbanIcon, SlidersHorizontalIcon, WarningIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { Repository } from "@usine/core";
import type { ProjectView } from "@usine/orchestrator";
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

export type OperatorView = "projects" | "configuration";

export const AppSidebar = ({
  projects,
  view,
  project,
  needsYou,
  live,
}: {
  readonly projects: ReadonlyArray<ProjectView>;
  readonly view: OperatorView;
  readonly project: Repository.Name | undefined;
  readonly needsYou: number;
  readonly live: boolean;
}) => (
  <Sidebar variant="inset">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<Link to="/" search={{}} />}>
            <span
              className="grid size-8 shrink-0 place-items-center rounded-md bg-primary font-heading text-sm font-semibold text-primary-foreground"
              aria-hidden="true"
            >
              U
            </span>
            <span className="font-heading text-sm font-medium">Usine</span>
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
                isActive={view === "projects" && project === undefined}
                render={<Link to="/" search={{}} />}
              >
                <KanbanIcon aria-hidden="true" />
                <span>Projects</span>
              </SidebarMenuButton>
              {needsYou > 0 && (
                <SidebarMenuBadge className="font-mono text-needs-you">{needsYou}</SidebarMenuBadge>
              )}
              {projects.length > 0 && (
                <SidebarMenuSub>
                  {projects.map((entry) => (
                    <SidebarMenuSubItem key={entry.repository}>
                      <SidebarMenuSubButton
                        isActive={project === entry.repository}
                        render={<Link to="/" search={{ project: entry.repository }} />}
                      >
                        <span className="truncate">{entry.repository}</span>
                        {entry.status === "needs-you" && (
                          <WarningIcon
                            weight="fill"
                            className="ml-auto text-needs-you"
                            aria-label="Needs you"
                          />
                        )}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Configuration</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "configuration"}
                render={<Link to="/" search={{ view: "configuration" }} />}
              >
                <SlidersHorizontalIcon aria-hidden="true" />
                <span>Loops</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      {/* Reports the trigger streams, not the server: idle pollers must never read as a running factory. */}
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1 font-mono text-[0.625rem]",
          live ? "text-run-succeeded" : "text-muted-foreground",
        )}
      >
        <CircleIcon weight="fill" className="size-2" aria-hidden="true" />
        {live ? "live" : "idle"}
      </div>
    </SidebarFooter>
  </Sidebar>
);
