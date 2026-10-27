import * as React from "react";

import { cn } from "~/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-card px-2 py-2 text-sm caret-primary transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
