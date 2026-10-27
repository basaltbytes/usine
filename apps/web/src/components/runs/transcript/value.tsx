import type { ReactNode } from "react";

type ValueProps = { readonly children: ReactNode };

export const Value = ({ children }: ValueProps) => (
  <span className="font-mono text-foreground">{children}</span>
);
