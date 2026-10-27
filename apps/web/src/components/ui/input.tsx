import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "~/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-md border border-input bg-card px-2 py-0.5 text-sm caret-primary transition-[color,border-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
