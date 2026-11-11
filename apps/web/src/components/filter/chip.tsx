import { XIcon } from "@phosphor-icons/react";
import { filterCopy } from "~/lib/strings";
import type { AppliedFilter, FilterField } from "./field";
import { FilterMenu } from "./menu";

const segment =
  "inline-flex min-w-0 items-center gap-1.5 px-2 outline-none transition-colors duration-100 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset aria-expanded:bg-secondary";

type FilterChipProps<Id extends string> = {
  readonly fields: readonly FilterField<Id>[];
  readonly filter: AppliedFilter<Id>;
  readonly onChange: (filter: AppliedFilter<Id>) => void;
  readonly onRemove: () => void;
};

export const FilterChip = <Id extends string>({
  fields,
  filter,
  onChange,
  onRemove,
}: FilterChipProps<Id>) => {
  const field = fields.find(({ id }) => id === filter.field);
  if (field === undefined) return null;
  const value =
    field.options.find((option) => option.value === filter.value)?.label ?? filter.value;
  const Glyph = field.icon;
  return (
    <div
      role="group"
      aria-label={filterCopy.applied(field.label, value)}
      className="inline-flex h-7 max-w-full min-w-0 items-stretch divide-x divide-input overflow-hidden rounded-md border border-input bg-secondary/50 text-sm max-sm:h-11 pointer-coarse:h-11"
    >
      <FilterMenu
        fields={fields}
        selected={filter}
        onSelect={onChange}
        trigger={
          <button type="button" className={`${segment} shrink-0 text-muted-foreground`}>
            <Glyph aria-hidden="true" className="size-4 shrink-0" />
            {field.label}
          </button>
        }
      />
      <span className="flex shrink-0 items-center px-2 text-muted-foreground">{filterCopy.is}</span>
      <FilterMenu
        fields={fields}
        field={field.id}
        selected={filter}
        onSelect={onChange}
        trigger={
          <button type="button" className={`${segment} font-medium text-foreground`}>
            <span className="min-w-0 truncate">{value}</span>
          </button>
        }
      />
      <button
        type="button"
        aria-label={filterCopy.remove}
        className={`${segment} shrink-0 justify-center px-1.5 text-muted-foreground hover:text-foreground max-sm:min-w-11 pointer-coarse:min-w-11`}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
};
