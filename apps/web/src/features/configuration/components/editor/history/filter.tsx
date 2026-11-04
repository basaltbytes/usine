import { Link, useNavigate } from "@tanstack/react-router";
import { ConfigurationEntityKind, type ConfigurationEntityKey } from "@usine/config/configuration";
import { Schema } from "effect";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { entityKey } from "~/features/configuration/lib/entities";
import { historyCopy } from "~/features/configuration/strings";

type HistoryFilterProps = { readonly entity?: ConfigurationEntityKey | undefined };

export const HistoryFilter = ({ entity }: HistoryFilterProps) => {
  const navigate = useNavigate({ from: "/configuration/history" });
  const id = useId();
  const [kind, setKind] = useState<ConfigurationEntityKind>(entity?.kind ?? "loop");
  const [identifier, setIdentifier] = useState<string>(entity?.identifier ?? "");
  return (
    <form
      className="grid min-w-0 grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap"
      onSubmit={(event) => {
        event.preventDefault();
        if (identifier.trim() === "") return;
        const key = entityKey(kind, identifier.trim());
        void navigate({
          search: (previous) => ({ ...previous, kind: key.kind, identifier: key.identifier }),
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-kind`}>{historyCopy.type}</Label>
        <NativeSelect
          id={`${id}-kind`}
          value={kind}
          onChange={(event) => {
            const next = Schema.decodeUnknownSync(ConfigurationEntityKind)(event.target.value);
            setKind(next);
            if (next === "settings") setIdentifier("instance");
          }}
        >
          {Object.entries(historyCopy.kinds).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:w-64">
        <Label htmlFor={`${id}-name`}>{historyCopy.name}</Label>
        <Input
          id={`${id}-name`}
          value={identifier}
          required
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setIdentifier(event.target.value)}
        />
      </div>
      <Button type="submit" variant="outline">
        {historyCopy.filter}
      </Button>
      {entity !== undefined && (
        <Link
          to="/configuration/history"
          search={{}}
          className="inline-flex min-h-7 items-center rounded-sm px-2 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {historyCopy.all}
        </Link>
      )}
    </form>
  );
};
