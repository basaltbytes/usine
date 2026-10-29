import { createTwoFilesPatch } from "diff";

export const configurationDiff = (name: string, before: string, after: string): string =>
  before === after
    ? ""
    : createTwoFilesPatch(
        before === "" ? "/dev/null" : `a/${name}`,
        after === "" ? "/dev/null" : `b/${name}`,
        before,
        after,
      );
