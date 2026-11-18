import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-1.5 text-xs/relaxed data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8",
        className,
      )}
      {...props}
    />
  );
}

const messageContentVariants = cva(
  "flex w-full min-w-0 flex-col gap-2 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end",
  {
    variants: {
      spacing: {
        compact: "gap-1",
        relaxed: "gap-3",
      },
    },
  },
);

function MessageContent({
  spacing,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageContentVariants>) {
  return (
    <div
      data-slot="message-content"
      className={cn(messageContentVariants({ spacing }), className)}
      {...props}
    />
  );
}

const messageHeaderVariants = cva(
  "flex max-w-full min-w-0 items-center px-2.5 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0",
  {
    variants: {
      variant: {
        speaker: "text-foreground",
        metadata: "gap-2",
      },
      inset: {
        false: "px-0",
      },
    },
  },
);

function MessageHeader({
  inset,
  variant,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageHeaderVariants>) {
  return (
    <div
      data-slot="message-header"
      className={cn(messageHeaderVariants({ variant, inset }), className)}
      {...props}
    />
  );
}

const messageFooterVariants = cva(
  "flex max-w-full min-w-0 items-center px-2.5 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
  {
    variants: {
      variant: {
        plain: "font-normal",
        flush: "px-0 font-normal",
        metadata: "gap-x-3 gap-y-1 px-0 font-normal",
      },
    },
  },
);

function MessageFooter({
  variant,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageFooterVariants>) {
  return (
    <div
      data-slot="message-footer"
      className={cn(messageFooterVariants({ variant }), className)}
      {...props}
    />
  );
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader };
