import { useId, useRef, useState } from "react";
import type { Stream } from "@usine/config/trigger";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  type FormFieldsProps,
  stringValue,
  fieldValue,
  withField,
} from "~/features/configuration/lib/forms";
import { loopFormCopy } from "~/features/configuration/strings";
import { completionAt, payloadCompletions } from "./completion";

type ExpressionFieldProps = FormFieldsProps & {
  readonly path: string;
  readonly label: string;
  readonly stream: Stream;
};
export const ExpressionField = ({
  value,
  onChange,
  problems,
  path,
  label,
  stream,
}: ExpressionFieldProps) => {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const text = stringValue(fieldValue(value, path));
  const token = completionAt(text, cursor);
  const suggestions = payloadCompletions(stream).filter((field) => field.startsWith(token.prefix));
  const errors = problems.filter((problem) => problem.path.join(".") === path);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        ref={textarea}
        value={text}
        className="min-h-24 font-mono [field-sizing:fixed]"
        aria-invalid={errors.length > 0}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          setCursor(event.target.selectionStart);
          setOpen(completionAt(event.target.value, event.target.selectionStart).prefix.length > 0);
          onChange(withField(value, path, event.target.value));
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.code === "Space") {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <div id={`${id}-help`} className="space-y-1 text-xs">
        <p className="text-muted-foreground">{loopFormCopy.completionHint}</p>
        {errors.map((error, index) => (
          <p
            key={index}
            role="alert"
            className="text-destructive whitespace-pre-wrap wrap-anywhere"
          >
            {error.message}
          </p>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {loopFormCopy.completions}
      </Button>
      {open && (
        <div
          className="flex max-h-40 flex-wrap gap-1 overflow-auto"
          role="group"
          aria-label={`${label} ${loopFormCopy.completions}`}
        >
          {suggestions.map((field) => (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="font-mono"
              key={field}
              onClick={() => {
                const next = text.slice(0, token.start) + field + text.slice(cursor);
                onChange(withField(value, path, next));
                setOpen(false);
                requestAnimationFrame(() => {
                  textarea.current?.focus();
                  textarea.current?.setSelectionRange(
                    token.start + field.length,
                    token.start + field.length,
                  );
                });
              }}
            >
              {field}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
};
