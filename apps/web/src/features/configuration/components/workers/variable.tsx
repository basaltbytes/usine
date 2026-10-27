import { Unset } from "~/features/configuration/components/section";

type VariableProps = { readonly name: string | null };

/** Renders the name of the orchestrator environment variable that holds a secret, never its value. */
export const Variable = ({ name }: VariableProps) =>
  name === null ? (
    <Unset>Not set</Unset>
  ) : (
    <>
      <Unset>Read from </Unset>
      <code className="font-mono text-xs">{name}</code>
    </>
  );
