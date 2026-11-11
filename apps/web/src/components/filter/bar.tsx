import { FunnelSimpleIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { Button } from "~/components/ui/button";
import { filterCopy } from "~/lib/strings";
import { FilterChip } from "./chip";
import type { AppliedFilter, FilterField } from "./field";
import { FilterMenu } from "./menu";

/** Puts `next` at `index` and drops any other filter on the same field. */
const replace = <Id extends string>(
  value: readonly AppliedFilter<Id>[],
  index: number,
  next: AppliedFilter<Id>,
) =>
  value.flatMap((filter, at) =>
    at === index ? [next] : filter.field === next.field ? [] : [filter],
  );

type FilterBarProps<Id extends string> = {
  readonly fields: readonly FilterField<Id>[];
  /** The applied filters, at most one per field, in the order they were added. */
  readonly value: readonly AppliedFilter<Id>[];
  readonly onValueChange: (value: readonly AppliedFilter<Id>[]) => void;
};

export const FilterBar = <Id extends string>({
  fields,
  value,
  onValueChange,
}: FilterBarProps<Id>) => {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {value.map((filter, index) => (
        <FilterChip
          // Keyed by position so a chip stays mounted while its field changes.
          key={index}
          fields={fields}
          filter={filter}
          onChange={(next) => onValueChange(replace(value, index, next))}
          onRemove={() => {
            onValueChange(value.filter((_, at) => at !== index));
            button.current?.focus();
          }}
        />
      ))}
      <FilterMenu
        fields={fields}
        onSelect={(next) => {
          const index = value.findIndex(({ field }) => field === next.field);
          onValueChange(index === -1 ? [...value, next] : replace(value, index, next));
        }}
        trigger={
          <Button
            ref={button}
            variant="outline"
            className="max-sm:h-11 pointer-coarse:h-11"
          >
            <FunnelSimpleIcon
              data-icon="inline-start"
              aria-hidden="true"
              className="text-muted-foreground"
            />
            {filterCopy.filter}
          </Button>
        }
      />
    </div>
  );
};
