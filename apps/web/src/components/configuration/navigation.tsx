import {
  ArrowsClockwiseIcon,
  BookBookmarkIcon,
  GearSixIcon,
  ClockCounterClockwiseIcon,
  TagIcon,
  HardDrivesIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { RepositoryMark } from "~/components/repository-mark";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";

export const CONFIGURATION_PAGES = [
  { to: "/configuration/loops", label: "Loops", icon: ArrowsClockwiseIcon },
  { to: "/configuration/agents", label: "Agents", icon: RobotIcon },
  { to: "/configuration/workers", label: "Workers", icon: HardDrivesIcon },
  { to: "/configuration/repositories", label: "Repositories", icon: BookBookmarkIcon },
  { to: "/configuration/labels", label: "Labels", icon: TagIcon },
  { to: "/configuration/history", label: "History", icon: ClockCounterClockwiseIcon },
  { to: "/configuration/settings", label: "Settings", icon: GearSixIcon },
] as const;

type ConfigurationMenuProps = { readonly inSection: boolean };

/** The open page's entry is active only when `inSection` is true. */
export const ConfigurationMenu = ({ inSection }: ConfigurationMenuProps) => {
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

/** Renders a breadcrumb such as `Configuration › Loops`, followed by the open entry. */
export const ConfigurationCrumbs = () => {
  const matchRoute = useMatchRoute();
  const params = useParams({ strict: false });
  const page = CONFIGURATION_PAGES.find(({ to }) => matchRoute({ to, fuzzy: true }) !== false);
  const repository =
    params.owner !== undefined && params.name !== undefined
      ? `${params.owner}/${params.name}`
      : undefined;
  const entry = params.loop ?? params.agent ?? params.worker ?? params.label ?? repository;
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
