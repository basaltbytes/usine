import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";

const textTooltip = TooltipPrimitive.createHandle<string>();

type TextTooltipProps = {
  /** The tooltip; without one, `children` renders alone. */
  readonly text: string | undefined;
  /**
   * Whether `text` repeats what screen readers already read from `children`: its full text cut
   * short on screen, or its `aria-label`. Otherwise `children` gets `text` as `aria-description`.
   */
  readonly repeats?: boolean;
  /** The element that shows the tooltip on hover and keyboard focus. It keeps its tag and props. */
  readonly children: ReactElement;
};

/**
 * Shows `text` in a tooltip on `children`, in place of a native `title`. The tooltip itself is the
 * one `TextTooltipProvider` renders.
 */
export const TextTooltip = ({ text, repeats = false, children }: TextTooltipProps) =>
  text === undefined ? (
    children
  ) : (
    <TooltipTrigger
      handle={textTooltip}
      payload={text}
      render={children}
      aria-description={repeats ? undefined : text}
    />
  );

type TextTooltipProviderProps = { readonly children: ReactNode };

/**
 * Renders `children` with the shared tooltip delay, and the one tooltip every `TextTooltip` in them
 * opens. Escape closes the tooltip and also reaches the dialog or popover around it.
 */
export const TextTooltipProvider = ({ children }: TextTooltipProviderProps) => (
  <TooltipProvider delay={400}>
    {children}
    <Tooltip
      handle={textTooltip}
      onOpenChange={(_open, details) => {
        if (details.reason === "escape-key") details.allowPropagation();
      }}
    >
      {({ payload }) => payload !== undefined && <TooltipContent>{payload}</TooltipContent>}
    </Tooltip>
  </TooltipProvider>
);
