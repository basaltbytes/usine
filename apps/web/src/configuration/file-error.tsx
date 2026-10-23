import type { ConfigFileError, FileStage } from "@usine/config/file";
import { Option } from "effect";

const stageLabel = {
  read: "The file could not be read",
  yaml: "The frontmatter is not valid YAML",
  frontmatter: "The frontmatter block is missing or not closed",
  schema: "A frontmatter field has an invalid value",
  expression: "An expression does not check",
  reference: "References something missing from the configuration",
} satisfies Record<FileStage, string>;

export const FileError = ({
  error,
  consequence,
}: {
  readonly error: ConfigFileError;
  readonly consequence: string;
}) => {
  const expression = Option.getOrUndefined(error.expression);
  return (
    <div className="flex max-w-[72ch] flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 wrap-anywhere">
        <p className="font-medium text-destructive">{stageLabel[error.stage]}</p>
        <p>{error.message}</p>
        {expression !== undefined && (
          <code className="mt-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {expression}
          </code>
        )}
      </div>
      <p className="text-muted-foreground">
        {consequence} Fix <code className="font-mono text-xs">{error.file}</code>, then reload the
        configuration.
      </p>
    </div>
  );
};
