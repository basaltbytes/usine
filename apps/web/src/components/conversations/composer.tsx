import { type Ref, useId } from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  composerHint,
  messageLabel,
  messagePlaceholder,
  sendingLabel,
  sendLabel,
} from "~/lib/conversations/strings";

type ComposerProps = {
  readonly value: string;
  readonly change: (value: string) => void;
  readonly send: () => void;
  readonly sending: boolean;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
};

/** A message box that sends with Enter and takes a new line with Shift+Enter. */
export const Composer = ({ value, change, send, sending, inputRef }: ComposerProps) => {
  const id = useId();
  const hint = useId();
  const empty = value.trim().length === 0;
  const submit = () => {
    if (!empty && !sending) send();
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={id} className="sr-only">
        {messageLabel}
      </Label>
      <Textarea
        ref={inputRef}
        id={id}
        value={value}
        rows={2}
        aria-describedby={hint}
        placeholder={messagePlaceholder}
        className="max-h-60 text-md max-sm:text-lg pointer-coarse:text-lg"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <p id={hint} className="text-xs text-muted-foreground max-sm:hidden">
          {composerHint}
        </p>
        <Button
          type="submit"
          className="ml-auto max-sm:h-11 pointer-coarse:h-11"
          disabled={empty || sending}
        >
          {sending ? sendingLabel : sendLabel}
        </Button>
      </div>
    </form>
  );
};
