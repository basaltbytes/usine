import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
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
  followUpPlaceholder,
  messageLabel,
  messagePlaceholder,
  sendingLabel,
  sendLabel,
  stoppingLabel,
  stopLabel,
} from "~/lib/conversations/strings";

type PromptInputProps = {
  readonly value: string;
  readonly change: (value: string) => void;
  readonly send: () => void;
  readonly sending: boolean;
  /** Cancels the running turn, or `undefined` when no turn runs or the member may not cancel. */
  readonly stop?: (() => void) | undefined;
  readonly stopping?: boolean;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
};

/**
 * The AI Elements prompt input on the Input Group: a message box that sends with Enter and takes
 * a new line with Shift+Enter, with one button in its bottom row. While a turn runs and the box is
 * empty, the button stops the turn; with text, it sends a message that queues after the turn.
 */
export const PromptInput = ({
  value,
  change,
  send,
  sending,
  stop,
  stopping = false,
  inputRef,
}: PromptInputProps) => {
  const hint = useId();
  const empty = value.trim().length === 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || sending) return;
        send();
        event.currentTarget.querySelector("textarea")?.focus();
      }}
    >
      <InputGroup className="bg-card dark:bg-card">
        <InputGroupTextarea
          ref={inputRef}
          value={value}
          rows={2}
          aria-label={messageLabel}
          aria-describedby={hint}
          placeholder={stop === undefined ? messagePlaceholder : followUpPlaceholder}
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
          {stop !== undefined && empty && !sending ? (
            <InputGroupButton
              type="button"
              variant="default"
              size="icon-sm"
              aria-label={stopping ? stoppingLabel : stopLabel}
              disabled={stopping}
              className="ml-auto rounded-full pointer-coarse:size-11 max-sm:size-11"
              onClick={(event) => {
                // The second click of a double-click on Send lands here once the draft clears.
                if (event.detail > 1) return;
                stop();
                // A key press (detail 0) disables the focused button, so focus goes to the box.
                if (event.detail === 0)
                  event.currentTarget.form?.querySelector("textarea")?.focus();
              }}
            >
              {stopping ? <Spinner /> : <StopIcon weight="fill" />}
            </InputGroupButton>
          ) : (
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
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};
