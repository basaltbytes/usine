import { CaretRightIcon } from "@phosphor-icons/react";
import { defaultFilter } from "cmdk";
import { useState, type ComponentProps } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "~/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { filterCopy } from "~/lib/strings";
import type { AppliedFilter, FilterField } from "./field";

const fieldValue = (id: string) => `field ${id}`;
const optionValue = ({ field, value }: AppliedFilter) => `value ${field} ${value}`;

type ValueItemsProps<Id extends string> = {
  readonly field: FilterField<Id>;
  readonly selected: AppliedFilter<Id> | undefined;
  readonly heading?: string | undefined;
  readonly onSelect: (filter: AppliedFilter<Id>) => void;
};

const ValueItems = <Id extends string>({
  field,
  selected,
  heading,
  onSelect,
}: ValueItemsProps<Id>) => (
  <CommandGroup heading={heading}>
    {field.options.map((option) => (
      <CommandItem
        key={option.value}
        value={optionValue({ field: field.id, value: option.value })}
        keywords={[option.label]}
        data-checked={selected?.field === field.id && selected.value === option.value}
        size="touch"
        onSelect={() => onSelect({ field: field.id, value: option.value })}
      >
        <span className="min-w-0 truncate">{option.label}</span>
      </CommandItem>
    ))}
  </CommandGroup>
);

type FilterMenuProps<Id extends string> = {
  readonly fields: readonly FilterField<Id>[];
  readonly trigger: NonNullable<ComponentProps<typeof PopoverTrigger>["render"]>;
  readonly onSelect: (filter: AppliedFilter<Id>) => void;
  /** Opens on this field's values instead of the field list. */
  readonly field?: Id | undefined;
  readonly selected?: AppliedFilter<Id> | undefined;
};

export const FilterMenu = <Id extends string>({
  fields,
  trigger,
  onSelect,
  field,
  selected,
}: FilterMenuProps<Id>) => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Id | undefined>(field);
  const [search, setSearch] = useState("");
  const current = fields.find(({ id }) => id === step);
  const available = fields.filter(({ options }) => options.length > 0);
  const show = (id: Id | undefined) => {
    setStep(id);
    setSearch("");
  };
  const pick = (filter: AppliedFilter<Id>) => {
    setOpen(false);
    onSelect(filter);
  };
  const highlighted =
    selected === undefined
      ? ""
      : current === undefined
        ? fieldValue(selected.field)
        : current.id === selected.field
          ? optionValue(selected)
          : "";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) show(field);
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent variant="menu" align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <Command
          variant="embedded"
          key={current?.id ?? ""}
          loop
          defaultValue={highlighted}
          filter={(value, query, keywords) => defaultFilter(keywords?.join(" ") ?? value, query)}
        >
          <CommandInput
            variant="touch"
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={current === undefined ? filterCopy.search : `${current.label}…`}
            aria-label={current?.label ?? filterCopy.filter}
            onKeyDown={(event) => {
              if (event.key !== "Backspace" || search !== "" || current === undefined) return;
              event.preventDefault();
              show(undefined);
            }}
          />
          <CommandList className="max-h-[min(18rem,50dvh)]">
            <CommandEmpty variant="compact">{filterCopy.empty}</CommandEmpty>
            {current === undefined ? (
              <>
                <CommandGroup>
                  {available.map(({ id, label, icon: Glyph }) => (
                    <CommandItem
                      key={id}
                      value={fieldValue(id)}
                      keywords={[label]}
                      size="touch"
                      onSelect={() => show(id)}
                    >
                      <Glyph aria-hidden="true" className="text-muted-foreground" />
                      {label}
                      <CommandShortcut>
                        <CaretRightIcon aria-hidden="true" className="size-3.5" />
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {search.trim() !== "" &&
                  available.map((each) => (
                    <ValueItems
                      key={each.id}
                      field={each}
                      selected={selected}
                      heading={each.label}
                      onSelect={pick}
                    />
                  ))}
              </>
            ) : (
              <ValueItems field={current} selected={selected} onSelect={pick} />
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
