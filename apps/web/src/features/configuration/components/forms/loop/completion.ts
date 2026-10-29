import { environmentFor } from "@usine/config/payload-slices";
import type { Stream } from "@usine/config/trigger";

/** Paths into the stream payload; list members use an index that the author can replace. */
export const payloadCompletions = (stream: Stream): readonly string[] => {
  const environment = environmentFor(stream);
  const paths: string[] = [];
  const visit = (path: string, type: string) => {
    paths.push(path);
    const element = /^list<(.+)>$/u.exec(type)?.[1];
    if (element !== undefined) visit(`${path}[0]`, element);
    else
      for (const field of environment.types.find((entry) => entry.name === type)?.fields ?? [])
        visit(`${path}.${field.name}`, field.type);
  };
  for (const variable of environment.variables) visit(variable.name, variable.type);
  return paths;
};

export const completionAt = (text: string, cursor: number) => {
  const prefix = /(?:item|repo)[\w.[\]]*$/u.exec(text.slice(0, cursor))?.[0] ?? "";
  return { prefix, start: cursor - prefix.length };
};
