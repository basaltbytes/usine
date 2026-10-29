import { useState } from "react";
import type {
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import {
  ConfigurationInvalidRefusal,
  StaleRevisionRefusal,
} from "@usine/orchestrator/operator/http";
import { Result, type Schema } from "effect";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { EntityFields } from "~/features/configuration/components/forms/entity";
import {
  formText,
  hasForm,
  readForm,
  validateForm,
  type FormProblem,
} from "~/features/configuration/lib/forms";
import { useConfigurationWrite } from "~/features/configuration/queries";
import { editorCopy, formCopy } from "~/features/configuration/strings";
import { Conflict } from "./conflict";
import { WriteFailure } from "./failure";
import { SourceEditor } from "./source";

type Draft =
  | { readonly mode: "text"; readonly text: string }
  | { readonly mode: "form"; readonly value: Schema.JsonObject };
const initialDraft = (entity: ConfigurationEntityKey, text: string): Draft => {
  if (hasForm(entity)) {
    const parsed = readForm(entity, text);
    if (Result.isSuccess(parsed)) return { mode: "form", value: parsed.success };
  }
  return { mode: "text", text };
};
type ConfigurationEditorFormProps = {
  readonly entity: ConfigurationEntityKey;
  readonly initial: { readonly text: string; readonly number: ConfigurationRevisionNumber };
  readonly onSaved: () => void;
  readonly cancel: () => void;
};

export const ConfigurationEditorForm = ({
  entity,
  initial,
  onSaved,
  cancel,
}: ConfigurationEditorFormProps) => {
  const [base, setBase] = useState(initial);
  const [editor, setEditor] = useState(() => initialDraft(entity, initial.text));
  const [draft, setDraft] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly FormProblem[]>([]);
  const [message, setMessage] = useState("");
  const write = useConfigurationWrite();
  const changeDraft = (next: Draft) => {
    setEditor(next);
    setProblems([]);
    if (write.error instanceof ConfigurationInvalidRefusal) write.reset();
  };
  const text = editor.mode === "text" ? editor.text : formText(entity, editor.value);
  const serverProblems =
    write.error instanceof ConfigurationInvalidRefusal
      ? write.error.problems.filter((problem) => problem.entity.key === entity.key)
      : [];
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (write.isPending || write.error instanceof StaleRevisionRefusal) return;
        if (editor.mode === "form") {
          const validated = validateForm(entity, editor.value);
          if (Result.isFailure(validated)) {
            setProblems(
              validated.failure.details ?? [{ path: [], message: validated.failure.message }],
            );
            return;
          }
        }
        setProblems([]);
        const payload =
          editor.mode === "text"
            ? { text, expected: base.number, message }
            : { value: editor.value, expected: base.number, message };
        write.mutate({ action: "save", key: entity, payload }, { onSuccess: onSaved });
      }}
    >
      {hasForm(entity) && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={write.isPending}
          onClick={() => {
            if (editor.mode === "form") {
              changeDraft({ mode: "text", text });
              setProblems([]);
              return;
            }
            const parsed = readForm(entity, editor.text);
            if (Result.isFailure(parsed)) {
              setProblems(
                parsed.failure.details ?? [{ path: [], message: parsed.failure.message }],
              );
              return;
            }
            setProblems([]);
            changeDraft({ mode: "form", value: parsed.success });
          }}
        >
          {editor.mode === "form" ? formCopy.text : formCopy.form}
        </Button>
      )}
      <fieldset disabled={write.isPending} className="min-w-0">
        {editor.mode === "text" ? (
          <SourceEditor
            value={editor.text}
            onChange={(text) => changeDraft({ mode: "text", text })}
            disabled={write.isPending}
          />
        ) : (
          <EntityFields
            key={base.number}
            entity={entity}
            value={editor.value}
            onChange={(value) => changeDraft({ mode: "form", value })}
            problems={[...problems, ...serverProblems]}
          />
        )}
      </fieldset>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-destructive wrap-anywhere">
          {problems.map((problem, index) => (
            <li key={index}>
              {problem.path.join(".")}: {problem.message}
            </li>
          ))}
        </ul>
      )}
      {write.isError &&
        (write.error instanceof StaleRevisionRefusal ? (
          <Conflict
            entity={entity}
            before={base.text}
            number={write.error.current}
            reload={(current) => {
              setDraft(text);
              setEditor(initialDraft(entity, current.text));
              setBase(current);
              setProblems([]);
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
