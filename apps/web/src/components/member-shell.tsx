import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SessionMenu } from "~/components/session-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { SidebarProvider } from "~/components/ui/sidebar";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { accountLabel, noAccessDescription, noAccessTitle } from "~/lib/strings";

type MemberShellProps = { readonly children: ReactNode };

export const MemberShell = ({ children }: MemberShellProps) => {
  const { data: session } = useSuspenseQuery(sessionQuery());
  const matchRoute = useMatchRoute();
  return (
    <PermissionsContext.Provider value={session.permissions}>
      {session.permissions.length > 0 ? (
        children
      ) : (
        <SidebarProvider className="flex-col">
          <nav className="w-full max-w-xs p-4" aria-label={accountLabel}>
            <SessionMenu />
          </nav>
          <main className="w-full max-w-3xl">
            {matchRoute({ to: "/tokens" }) !== false ? (
              <Outlet />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{noAccessTitle}</EmptyTitle>
                  <EmptyDescription>{noAccessDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </main>
        </SidebarProvider>
      )}
    </PermissionsContext.Provider>
  );
};
