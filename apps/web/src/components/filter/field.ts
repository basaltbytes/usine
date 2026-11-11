import type { Icon } from "@phosphor-icons/react";

export type FilterOption = { readonly value: string; readonly label: string };

export type FilterField<Id extends string = string> = {
  readonly id: Id;
  readonly label: string;
  readonly icon: Icon;
  readonly options: readonly FilterOption[];
};

export type AppliedFilter<Id extends string = string> = {
  readonly field: Id;
  readonly value: string;
};
