import { useRef, type ComponentProps } from "react";
import { Button } from "~/components/ui/button";
import { usePageCommands } from "./context";

type CommandButtonProps = Omit<ComponentProps<typeof Button>, "ref"> & { readonly command: string };

/** Invokes the existing button so form validation and confirmation controls also apply in the palette. */
export const CommandButton = ({ command, disabled, ...props }: CommandButtonProps) => {
  const button = useRef<HTMLButtonElement>(null);
  usePageCommands(
    disabled
      ? []
      : [
          {
            label: command,
            run: () => {
              if (button.current?.isConnected && !button.current.matches(":disabled")) {
                button.current.focus();
                button.current.click();
              }
            },
          },
        ],
  );
  return <Button {...props} ref={button} disabled={disabled} />;
};
