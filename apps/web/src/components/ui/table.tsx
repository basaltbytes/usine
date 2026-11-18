import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({
  className,
  divided = false,
  ...props
}: React.ComponentProps<"tbody"> & { divided?: boolean }) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", divided && "border-t", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

const tableRowVariants = cva("border-b transition-colors data-[state=selected]:bg-muted", {
  variants: {
    variant: {
      default: "hover:bg-muted/40 has-aria-expanded:bg-muted/40",
      static: "hover:bg-transparent has-aria-expanded:bg-muted/40",
      plain: "hover:bg-transparent has-aria-expanded:bg-transparent",
      interactive:
        "cursor-pointer hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60 has-aria-expanded:bg-muted/40",
      linked:
        "relative hover:bg-muted/60 has-[a[data-row-link]:focus-visible]:bg-muted/60 has-aria-expanded:bg-muted/40",
    },
  },
  defaultVariants: { variant: "default" },
});

function TableRow({
  className,
  variant,
  ...props
}: React.ComponentProps<"tr"> & VariantProps<typeof tableRowVariants>) {
  return (
    <tr data-slot="table-row" className={cn(tableRowVariants({ variant }), className)} {...props} />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

const tableCellVariants = cva("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", {
  variants: {
    variant: {
      default: "",
      mono: "font-mono text-xs",
      numeric: "font-mono text-xs tabular-nums",
      total: "font-mono text-xs/5 tabular-nums",
      count: "tabular-nums",
      label: "font-medium",
    },
    size: {
      default: "",
      roomy: "py-3",
      action: "py-2.5",
      detail: "px-2 pt-1 pb-4",
      continuation: "pt-0 pb-1",
    },
    tone: {
      default: "",
      muted: "text-muted-foreground",
      subtle: "text-foreground/90",
      destructive: "text-destructive",
    },
    truncate: { true: "truncate" },
  },
  defaultVariants: { variant: "default", size: "default", tone: "default" },
});

function TableCell({
  className,
  variant,
  size,
  tone,
  truncate,
  ...props
}: React.ComponentProps<"td"> & VariantProps<typeof tableCellVariants>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(tableCellVariants({ variant, size, tone, truncate }), className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
