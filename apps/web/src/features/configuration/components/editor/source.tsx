import { useId, useRef } from "react";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { editorCopy } from "~/features/configuration/strings";

type SourceEditorProps = {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
};

export const SourceEditor = ({
  value,
  onChange,
  label = editorCopy.source,
  disabled,
}: SourceEditorProps) => {
  const id = useId();
  const gutter = useRef<HTMLPreElement>(null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-w-0 overflow-hidden rounded-md border bg-card">
        <pre
          ref={gutter}
          aria-hidden="true"
          className="m-0 max-h-96 shrink-0 overflow-hidden border-r px-3 py-2 text-right font-mono text-xs leading-5 text-muted-foreground select-none"
        >
          {value
            .split("\n")
            .map((_, index) => index + 1)
            .join("\n")}
        </pre>
        <Textarea
          id={id}
          value={value}
          readOnly={onChange === undefined}
          disabled={disabled}
          spellCheck={false}
          wrap="off"
          className="h-96 min-w-0 flex-1 rounded-none border-0 font-mono text-xs leading-5 [field-sizing:fixed]"
          onScroll={(event) => {
            if (gutter.current !== null) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    </div>
  );
};
