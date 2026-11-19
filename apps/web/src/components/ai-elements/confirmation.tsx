// Adapted from Vercel AI Elements. See README.md and LICENSE in this folder.
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** Where an approval stands: asked, or answered with an acceptance or a rejection. */
export type ConfirmationState = "requested" | "accepted" | "rejected";

const ConfirmationContext = createContext<ConfirmationState | null>(null);

const useConfirmation = () => {
  const state = useContext(ConfirmationContext);
  if (state === null) throw new Error("Confirmation components must be used within Confirmation");
  return state;
};

type ConfirmationProps = ComponentProps<"div"> & { readonly state: ConfirmationState };

/** An approval of one tool call; a call that waits for its answer has the attention tone. */
export const Confirmation = ({ state, className, ...props }: ConfirmationProps) => (
  <ConfirmationContext.Provider value={state}>
    <div
      role="group"
      data-slot="confirmation"
      data-state={state}
      className={cn(
        "not-prose flex min-w-0 flex-col gap-2 rounded-lg border px-3 pt-2.5 pb-3 text-sm",
        state === "requested" ? "border-needs-you/30 bg-needs-you/6" : "border-border bg-card",
        className,
      )}
      {...props}
    />
  </ConfirmationContext.Provider>
);

/** The call that the approval is for. */
export const ConfirmationTitle = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex min-w-0 items-start gap-2", className)} {...props} />
);

type ConfirmationPartProps = { readonly children?: ReactNode };

/** Shown while the approval is asked. */
export const ConfirmationRequest = ({ children }: ConfirmationPartProps) =>
  useConfirmation() === "requested" ? children : null;

/** Shown once the call was accepted. */
export const ConfirmationAccepted = ({ children }: ConfirmationPartProps) =>
  useConfirmation() === "accepted" ? children : null;

/** Shown once the call was rejected. */
export const ConfirmationRejected = ({ children }: ConfirmationPartProps) =>
  useConfirmation() === "rejected" ? children : null;

/** The answers, shown while the approval is asked. */
export const ConfirmationActions = ({ className, ...props }: ComponentProps<"div">) =>
  useConfirmation() === "requested" ? (
    <div className={cn("flex flex-wrap items-center gap-2 pt-1", className)} {...props} />
  ) : null;

/** One answer. */
export const ConfirmationAction = ({
  variant = "outline",
  ...props
}: ComponentProps<typeof Button>) => (
  <Button type="button" variant={variant} className="pointer-coarse:h-11" {...props} />
);
