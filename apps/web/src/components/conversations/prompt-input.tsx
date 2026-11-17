import { ArrowUpIcon } from "@phosphor-icons/react";
import { type Ref, useId } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "~/components/ui/input-group";
import { Spinner } from "~/components/ui/spinner";
import {
  composerHint,
  messageLabel,
  messagePlaceholder,
  sendingLabel,
  sendLabel,
} from "~/lib/conversations/strings";

type PromptInputProps = {
  readonly value: string;
  readonly change: (value: string) => void;
  readonly send: () => void;
  readonly sending: boolean;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
};

/**
 * The AI Elements prompt input on the Input Group: a message box that sends with Enter and takes
 * a new line with Shift+Enter, with the send button in its bottom row.
 */
export const PromptInput = ({ value, change, send, sending, inputRef }: PromptInputProps) => {
  const hint = useId();
  const empty = value.trim().length === 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !sending) send();
      }}
    >
      <InputGroup className="bg-card dark:bg-card">
        <InputGroupTextarea
          ref={inputRef}
          value={value}
          rows={2}
          aria-label={messageLabel}
          aria-describedby={hint}
          placeholder={messagePlaceholder}
          className="max-h-60 min-h-14 px-3 pt-2.5 text-md max-sm:text-lg pointer-coarse:text-lg"
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="cursor-default gap-2 px-3 pb-2.5">
          <InputGroupText id={hint} className="font-normal max-sm:sr-only">
            {composerHint}
          </InputGroupText>
          <InputGroupButton
            type="submit"
            variant="default"
            size="icon-sm"
            aria-label={sending ? sendingLabel : sendLabel}
            disabled={empty || sending}
            className="ml-auto rounded-full pointer-coarse:size-11 max-sm:size-11"
          >
            {sending ? <Spinner /> : <ArrowUpIcon weight="bold" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};
