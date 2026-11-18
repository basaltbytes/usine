import type { ComponentProps } from "react";
import { Card } from "~/components/ui/card";
import { cn } from "~/lib/utils";

type CardFrameProps = Readonly<ComponentProps<typeof Card>> & {
  /** Whether the Task needs the operator, which turns the ring peach. */
  readonly needsYou: boolean;
};

/** Renders the small registry card that holds a Board card's face, on the board and while dragged. */
export const CardFrame = ({ needsYou, className, ...props }: CardFrameProps) => (
  <Card
    size="sm"
    className={cn(
      "relative gap-0 py-2.5 transition-shadow hover:ring-foreground/15 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70 has-[:focus-visible]:ring-inset",
      needsYou && "ring-needs-you/45 hover:ring-needs-you/65",
      className,
    )}
    {...props}
  />
);
