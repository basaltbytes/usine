import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

export const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));

/** Returns a filter that rejects two names GitHub treats as the same repository. */
export const uniqueRepositoryNames = <A>(nameOf: (value: A) => RepositoryName) =>
  Schema.makeFilter<ReadonlyArray<A>>(
    (values) =>
      new Set(values.map((value) => canonicalRepositoryName(nameOf(value)))).size === values.length,
    { message: "Expected unique repository names, ignoring case" },
  );
