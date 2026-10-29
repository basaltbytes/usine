import { useState } from "react";
import type {
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import { StaleRevisionRefusal } from "@usine/orchestrator/operator/http";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Conflict } from "./conflict";
import { WriteFailure } from "./failure";
import { SourceEditor } from "./source";
import { useConfigurationWrite } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";

type RawEditorProps = {
  readonly entity: ConfigurationEntityKey;
  readonly initial: { readonly text: string; readonly number: ConfigurationRevisionNumber };
  readonly onSaved: () => void;
  readonly cancel: () => void;
};

export const RawEditor = ({ entity, initial, onSaved, cancel }: RawEditorProps) => {
  const [base, setBase] = useState(initial);
  const [text, setText] = useState(initial.text);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const write = useConfigurationWrite();
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (write.isPending || write.error instanceof StaleRevisionRefusal) return;
        write.mutate(
          { action: "save", key: entity, payload: { text, expected: base.number, message } },
          { onSuccess: onSaved },
        );
      }}
    >
      <SourceEditor value={text} onChange={setText} disabled={write.isPending} />
      {write.isError &&
        (write.error instanceof StaleRevisionRefusal ? (
          <Conflict
            entity={entity}
            before={base.text}
            number={write.error.current}
            reload={(current) => {
              setDraft(text);
              setText(current.text);
              setBase(current);
              write.reset();
            }}
          />
        ) : (
          <WriteFailure error={write.error} />
        ))}
      <Label className="flex flex-col items-start gap-2">
        {editorCopy.message}
        <Input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={write.isPending}
        />
      </Label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={write.isPending || write.error instanceof StaleRevisionRefusal}
        >
          {write.isPending ? editorCopy.saving : editorCopy.save}
        </Button>
        <Button type="button" variant="ghost" onClick={cancel} disabled={write.isPending}>
          {editorCopy.cancel}
        </Button>
      </div>
      {draft !== null && <SourceEditor label={editorCopy.draft} value={draft} />}
    </form>
  );
};
