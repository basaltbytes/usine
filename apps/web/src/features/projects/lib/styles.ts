import { cn } from "~/lib/utils";

export const cardClass = (needsYou: boolean) =>
  cn(
    "relative gap-0 py-2.5 transition-[box-shadow] hover:ring-foreground/15 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70",
    needsYou && "ring-needs-you/45 hover:ring-needs-you/65",
  );
