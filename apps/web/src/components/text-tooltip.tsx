import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

type TextTooltipProps = {
  /** The tooltip; without one, `children` renders alone. */
  readonly text: string | undefined;
  /** The element that shows the tooltip on hover and keyboard focus. It keeps its tag and props. */
  readonly children: ReactElement;
};

/** Shows `text` in a tooltip on `children`, in place of a native `title`. */
export const TextTooltip = ({ text, children }: TextTooltipProps) =>
  text === undefined ? (
    children
  ) : (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="whitespace-pre-line wrap-anywhere">{text}</TooltipContent>
    </Tooltip>
  );
