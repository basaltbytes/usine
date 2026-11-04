import type { ReactNode } from "react";

type ConfigurationHeaderProps = {
  readonly heading: ReactNode;
  readonly actions?: ReactNode;
};

export const ConfigurationHeader = ({ heading, actions }: ConfigurationHeaderProps) => (
  <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
    {heading}
    {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
