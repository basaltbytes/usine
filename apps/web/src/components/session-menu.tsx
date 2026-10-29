import { Link, useMatchRoute } from "@tanstack/react-router";
import { KeyIcon, SignOutIcon, UsersIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { membersLabel, tokensPageLabel, signOutLabel } from "~/lib/strings";

export const SessionMenu = () => {
  const matchRoute = useMatchRoute();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const signOut = async () => {
    setPending(true);
    try {
      await authRequest("/api/auth/sign-out", Acknowledged, { method: "POST" });
      window.location.replace("/sign-in");
    } catch (cause) {
      setError(rejectionMessage(cause));
      setPending(false);
    }
  };
  return (
    <>
      {error !== undefined && <ErrorAlert message={error} />}
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={matchRoute({ to: "/members" }) !== false}
            render={<Link to="/members" />}
          >
            <UsersIcon aria-hidden="true" />
            {membersLabel}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={matchRoute({ to: "/tokens" }) !== false}
            render={<Link to="/tokens" />}
          >
            <KeyIcon aria-hidden="true" />
            {tokensPageLabel}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton disabled={pending} onClick={() => void signOut()}>
            <SignOutIcon aria-hidden="true" />
            {signOutLabel}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
};
