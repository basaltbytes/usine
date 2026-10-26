import {
  ArrowsClockwiseIcon,
  BookBookmarkIcon,
  GearSixIcon,
  HardDrivesIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useMatchRoute,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { ErrorAlert } from "@/components/error-alert";
import { Page } from "@/components/page";
import { RepositoryMark } from "@/components/repository-mark";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { rejectionMessage } from "../api.ts";
import { overviewQuery } from "../overview.ts";
import { usePauseLoop } from "./query.ts";
import { SectionReloadProvider } from "./reload.tsx";

const CONFIGURATION_PAGES = [
  { to: "/configuration/loops", label: "Loops", icon: ArrowsClockwiseIcon },
  { to: "/configuration/agents", label: "Agents", icon: RobotIcon },
  { to: "/configuration/workers", label: "Workers", icon: HardDrivesIcon },
  { to: "/configuration/repositories", label: "Repositories", icon: BookBookmarkIcon },
  { to: "/configuration/settings", label: "Settings", icon: GearSixIcon },
] as const;

/** The open page's entry is active only when `inSection` is true. */
export const ConfigurationMenu = ({ inSection }: { readonly inSection: boolean }) => {
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenu>
      {CONFIGURATION_PAGES.map(({ to, label, icon: Glyph }) => (
        <SidebarMenuItem key={to}>
          <SidebarMenuButton
            isActive={inSection && matchRoute({ to, fuzzy: true }) !== false}
            render={<Link to={to} />}
          >
            <Glyph aria-hidden="true" />
            <span>{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
};

/** Shares one reload state across all Configuration pages. */
export const ConfigurationSection = () => (
  <SectionReloadProvider>
    <Outlet />
  </SectionReloadProvider>
);

export const ConfigurationPending = () => (
  <Page width="full">
    <div className="flex items-center justify-between gap-4" aria-busy="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-7 w-44" />
    </div>
    <span className="sr-only">Loading the configuration</span>
    <div className="flex flex-col gap-3 pt-3">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-5 w-full" />
      ))}
    </div>
  </Page>
);

export const ConfigurationUnavailable = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  return (
    <Page width="full">
      <ErrorAlert title="Could not load the configuration" message={rejectionMessage(error)} />
      <div>
        <Button variant="outline" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </div>
    </Page>
  );
};

/** Returns `null` if operator actions are unavailable, as in setup mode. */
export const useLoopPause = () => {
  const pause = usePauseLoop();
  const { data } = useSuspenseQuery(overviewQuery());
  return data._tag === "NeedsSetup" ? null : pause;
};

/** Renders a breadcrumb such as `Configuration › Loops`, followed by the open entry. */
export const ConfigurationCrumbs = () => {
  const matchRoute = useMatchRoute();
  const params = useParams({ strict: false });
  const page = CONFIGURATION_PAGES.find(({ to }) => matchRoute({ to, fuzzy: true }) !== false);
  const repository =
    params.owner !== undefined && params.name !== undefined
      ? `${params.owner}/${params.name}`
      : undefined;
  const entry = params.loop ?? params.agent ?? params.worker ?? repository;
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink render={<Link to="/configuration/loops" />}>Configuration</BreadcrumbLink>
      </BreadcrumbItem>
      {page !== undefined && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {entry === undefined ? (
              <BreadcrumbPage>{page.label}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link to={page.to} />}>{page.label}</BreadcrumbLink>
            )}
          </BreadcrumbItem>
        </>
      )}
      {entry !== undefined && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="flex items-center gap-1.5 wrap-anywhere">
              {repository !== undefined && Schema.is(RepositoryName)(repository) && (
                <RepositoryMark repository={repository} />
              )}
              {entry}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </>
      )}
    </>
  );
};
