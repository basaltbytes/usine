import { createLink } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type ButtonAnchorProps = Readonly<ComponentProps<"a"> & VariantProps<typeof buttonVariants>>;

const ButtonAnchor = ({ variant, size, className, ...props }: ButtonAnchorProps) => (
  <a className={cn(buttonVariants({ variant, size }), className)} {...props} />
);

/** Renders a router link that looks like the registry `Button` and keeps the link role. */
export const ButtonLink = createLink(ButtonAnchor);
