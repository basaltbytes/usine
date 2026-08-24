import { Effect } from "effect";
import { ConfigFileError } from "./errors.ts";

export interface MarkdownParts {
  readonly yaml: string;
  readonly body: string;
  readonly newline: "\n" | "\r\n";
}

const closingDelimiterAt = (source: string, newline: "\n" | "\r\n", from: number): number => {
  const delimiter = `${newline}---`;
  let candidate = source.indexOf(delimiter, from);
  while (candidate >= 0) {
    const afterDelimiter = candidate + delimiter.length;
    if (afterDelimiter === source.length || source.startsWith(newline, afterDelimiter)) {
      return candidate;
    }
    candidate = source.indexOf(delimiter, afterDelimiter);
  }
  return -1;
};

/** Split Markdown frontmatter without interpreting either half. */
export const splitMarkdown = (
  file: string,
  source: string,
): Effect.Effect<MarkdownParts, ConfigFileError> => {
  const newline = source.startsWith("---\r\n")
    ? "\r\n"
    : source.startsWith("---\n")
      ? "\n"
      : undefined;
  if (newline === undefined) {
    return new ConfigFileError({
      file,
      stage: "frontmatter",
      message: "Expected the file to start with a YAML frontmatter delimiter (---)",
    });
  }

  const yamlStart = 3 + newline.length;
  const closingDelimiter = `${newline}---`;
  const yamlEnd = closingDelimiterAt(source, newline, yamlStart);
  if (yamlEnd < 0) {
    return new ConfigFileError({
      file,
      stage: "frontmatter",
      message: "Expected a closing YAML frontmatter delimiter (---)",
    });
  }

  const afterDelimiter = yamlEnd + closingDelimiter.length;
  const bodyStart = source.startsWith(newline, afterDelimiter)
    ? afterDelimiter + newline.length
    : afterDelimiter;
  return Effect.succeed({
    yaml: source.slice(yamlStart, yamlEnd),
    body: source.slice(bodyStart),
    newline,
  });
};
