import type { ReactNode } from "react";

type MetaProps = { readonly label: string; readonly value?: ReactNode };

export const Meta = ({ label, value }: MetaProps) => (
  <span>
    {label}
    {value !== undefined && <> {value}</>}
  </span>
);
