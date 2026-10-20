import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute, useParams, useRouter } from "@tanstack/react-router";
import { ErrorAlert } from "@/components/error-alert";
import { Page } from "@/components/page";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { overviewQuery } from "../overview.ts";
import { usePauseLoop } from "./query.ts";
import { SectionReloadProvider } from "./reload.tsx";

/** The section's pages, in sidebar order. */
const CONFIGURATION_PAGES = [
  { to: "/configuration/loops", label: "Loops" },
  { to: "/configuration/agents", label: "Agents" },
  { to: "/configuration/workers", label: "Workers" },
  { to: "/configuration/repositories", label: "Repositories" },
  { to: "/configuration/settings", label: "Settings" },
] as const;

/** The section's entries in the sidebar; the open page's entry is active while `inSection`. */
export const ConfigurationMenu = ({ inSection }: { readonly inSection: boolean }) => {
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenu>
      {CONFIGURATION_PAGES.map(({ to, label }) => (
        <SidebarMenuItem key={to}>
          <SidebarMenuButton
            isActive={inSection && matchRoute({ to, fuzzy: true }) !== false}
            render={<Link to={to} />}
          >
            <span>{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
};

/** The Configuration section around its pages, keeping one reload for all of them. */
export const ConfigurationSection = () => (
  <SectionReloadProvider>
    <Outlet />
  </SectionReloadProvider>
);

/** Shown while the configuration loads: the heading row and a few table rows. */
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

/** Shown when the server did not answer with the configuration. */
export const ConfigurationUnavailable = ({ error }: { readonly error: Error }) => {
  const router = useRouter();
  return (
    <Page width="full">
      <ErrorAlert title="The configuration could not be read" message={error.message} />
      <div>
        <Button variant="outline" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </div>
    </Page>
  );
};

/** Pause and Resume for Loops, or null while operator actions are unavailable, as in setup mode. */
export const useLoopPause = () => {
  const pause = usePauseLoop();
  const { data } = useSuspenseQuery(overviewQuery());
  return data._tag === "NeedsSetup" ? null : pause;
};

/** The header breadcrumb inside the section: `Configuration › Loops`, then the open entry. */
export const ConfigurationCrumbs = () => {
  const matchRoute = useMatchRoute();
  const params = useParams({ strict: false });
  const page = CONFIGURATION_PAGES.find(({ to }) => matchRoute({ to, fuzzy: true }) !== false);
  const entry =
    params.loop ??
    params.agent ??
    params.worker ??
    (params.owner !== undefined && params.name !== undefined
      ? `${params.owner}/${params.name}`
      : undefined);
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
            <BreadcrumbPage className="wrap-anywhere">{entry}</BreadcrumbPage>
          </BreadcrumbItem>
        </>
      )}
    </>
  );
};
