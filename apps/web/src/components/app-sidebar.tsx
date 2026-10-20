import { Link } from "@tanstack/react-router";
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
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ConfigurationMenu } from "../configuration/layout.tsx";
import { projectParams } from "../overview.ts";

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
  readonly project: RepositoryName | undefined;
  /** How many Needs you entries concern each Project. */
  readonly needsYou: ReadonlyMap<RepositoryName, number>;
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
        <SidebarGroupLabel
          render={<Link to="/" />}
          className={cn(view === "projects" && project === undefined && "text-foreground")}
        >
          Projects
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {projects.map((entry) => {
              const count = needsYou.get(entry.repository) ?? 0;
              return (
                <SidebarMenuItem key={entry.repository}>
                  <SidebarMenuButton
                    isActive={project === entry.repository}
                    className={cn(count > 0 && "pr-8")}
                    render={
                      <Link to="/projects/$owner/$name" params={projectParams(entry.repository)} />
                    }
                  >
                    <span>{entry.repository}</span>
                  </SidebarMenuButton>
                  {count > 0 && (
                    <SidebarMenuBadge className="text-needs-you peer-data-active/menu-button:text-needs-you">
                      {count}
                      <span className="sr-only"> need you</span>
                    </SidebarMenuBadge>
                  )}
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
