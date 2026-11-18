import type { ComponentProps } from "react";
import { Card } from "~/components/ui/card";
import { cn } from "~/lib/utils";

type CardFrameProps = Readonly<Omit<ComponentProps<typeof Card>, "variant" | "tone">> & {
  /** Whether the Task needs the operator, which turns the ring peach. */
  readonly needsYou: boolean;
};

/** Renders the small registry card that holds a Board card's face, on the board and while dragged. */
export const CardFrame = ({ needsYou, className, ...props }: CardFrameProps) => (
  <Card
    size="sm"
    variant="interactive"
    tone={needsYou ? "attention" : undefined}
    className={cn("relative", className)}
    {...props}
  />
);
