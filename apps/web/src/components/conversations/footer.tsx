import { WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { conversationStatusQuery } from "~/lib/conversations/queries";
import { setupRequiredTitle } from "~/lib/conversations/strings";

type SetupRequiredProps = { readonly reason: string };

export const SetupRequired = ({ reason }: SetupRequiredProps) => (
  <Alert className="border-needs-you/30 bg-needs-you/8">
    <WarningIcon weight="fill" className="text-needs-you" />
    <AlertTitle>{setupRequiredTitle}</AlertTitle>
    <AlertDescription className="wrap-anywhere">{reason}</AlertDescription>
  </Alert>
);

type PanelFooterProps = {
  /** Why this member can't post here, or `undefined` when they can. */
  readonly readOnly: string | undefined;
  readonly children: ReactNode;
};

/**
 * Renders the panel's foot: the setup reason while the supervisor takes no messages, the
 * read-only note for a member who can't post, or `children`, the composer.
 */
export const PanelFooter = ({ readOnly, children }: PanelFooterProps) => {
  const status = useQuery(conversationStatusQuery());
  const content =
    status.data?.state === "setup-required" ? (
      <SetupRequired reason={status.data.reason ?? ""} />
    ) : readOnly !== undefined ? (
      <p className="text-sm text-muted-foreground">{readOnly}</p>
    ) : status.data === undefined ? null : (
      children
    );
  return content === null ? null : (
    <div className="shrink-0 border-t px-5 pt-4 pb-[max(--spacing(5),env(safe-area-inset-bottom))]">
      <div className="mx-auto w-full max-w-3xl">{content}</div>
    </div>
  );
};
