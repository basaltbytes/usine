import { defaultFilter } from "cmdk";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { FactoryOverview } from "@usine/orchestrator/operator";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import { PageCommandsContext } from "./context";
import { NavigationCommands } from "./navigation";
import { paletteCopy } from "./strings";

type CommandPaletteProps = { readonly overview: FactoryOverview };

export const CommandPalette = ({ overview }: CommandPaletteProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const commands = useContext(PageCommandsContext);
  const currentCommands = useRef(commands);
  currentCommands.current = commands;
  const selected = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const show = () => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    setSearch("");
    setOpen(true);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.repeat
      )
        return;
      event.preventDefault();
      if (open) setOpen(false);
      else show();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [open]);
  const select = (run: () => void) => {
    selected.current = run;
    setOpen(false);
  };
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        aria-label={paletteCopy.open}
        aria-keyshortcuts="Meta+K Control+K"
        title="Commands (⌘K / Ctrl+K)"
        onClick={show}
      >
        <MagnifyingGlassIcon aria-hidden="true" />
      </Button>
      <CommandDialog
        title={paletteCopy.title}
        description={paletteCopy.description}
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(opened) => {
          if (opened) return;
          const action = selected.current;
          selected.current = null;
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          action?.();
        }}
      >
        <Command
          filter={(value, search) =>
            /^#?\d+$/u.test(search.trim())
              ? Number(value.split(" ").includes(`#${search.trim().replace(/^#/u, "")}`))
              : defaultFilter(value, search)
          }
        >
          <CommandInput
            autoFocus
            aria-label={paletteCopy.search}
            placeholder={paletteCopy.search}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[min(18rem,50dvh)]">
            <CommandEmpty>{paletteCopy.empty}</CommandEmpty>
            {commands.length > 0 && (
              <CommandGroup heading={paletteCopy.actions}>
                {commands.map(({ id, label }) => (
                  <CommandItem
                    key={id}
                    value={`action ${label}`}
                    onSelect={() =>
                      select(() =>
                        currentCommands.current.find((command) => command.id === id)?.run(),
                      )
                    }
                  >
                    {label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <NavigationCommands
              overview={overview}
              select={select}
              searching={search.trim().length > 0}
            />
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
};
