import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const emptyVariants = cva(
  "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance",
  {
    variants: {
      variant: {
        flush: "p-0",
        section: "p-0 py-6",
        list: "gap-3 rounded-lg border border-input px-5 py-5 text-wrap",
      },
    },
  },
);

function Empty({
  variant,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyVariants>) {
  return <div data-slot="empty" className={cn(emptyVariants({ variant }), className)} {...props} />;
}

const emptyHeaderVariants = cva("flex max-w-sm flex-col items-center gap-1", {
  variants: {
    spacing: {
      relaxed: "gap-2",
      compact: "gap-0.5",
    },
  },
});

function EmptyHeader({
  spacing,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyHeaderVariants>) {
  return (
    <div
      data-slot="empty-header"
      className={cn(emptyHeaderVariants({ spacing }), className)}
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
      },
      tone: {
        destructive: "text-destructive",
        foreground: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  tone,
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, tone }), className)}
      {...props}
    />
  );
}

const emptyTitleVariants = cva("font-heading text-sm font-medium tracking-tight", {
  variants: {
    variant: {
      heading: "text-md font-semibold tracking-normal",
      list: "font-sans text-sm tracking-normal",
    },
  },
});

function EmptyTitle({
  variant,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyTitleVariants>) {
  return (
    <div
      data-slot="empty-title"
      className={cn(emptyTitleVariants({ variant }), className)}
      {...props}
    />
  );
}

const emptyDescriptionVariants = cva(
  "text-xs/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
  {
    variants: {
      variant: {
        body: "text-sm",
        list: "text-pretty text-sm",
      },
    },
  },
);

function EmptyDescription({
  variant,
  className,
  ...props
}: React.ComponentProps<"p"> & VariantProps<typeof emptyDescriptionVariants>) {
  return (
    <div
      data-slot="empty-description"
      className={cn(emptyDescriptionVariants({ variant }), className)}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-2 text-xs/relaxed text-balance",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
