import { Effect, Option } from "effect";
import { ContinuationMismatchError, type ChildRequest } from "../runtime.ts";

export const checkContinuation = Effect.fn("HarnessContinuation.check")(function* (
  request: ChildRequest,
  field: ContinuationMismatchError["field"],
  saved: Option.Option<string>,
  current: Option.Option<string>,
) {
  yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, field });
  if (Option.getOrNull(saved) === Option.getOrNull(current)) return;
  const message = `Cannot resume ${request.session.brain.harness}: ${field} mismatch (saved ${Option.getOrElse(saved, () => "default")}, current ${Option.getOrElse(current, () => "default")})`;
  yield* Effect.logWarning("Saved child continuation refused", {
    sessionId: request.session.id,
    field,
    message,
  });
  return yield* ContinuationMismatchError.make({ sessionId: request.session.id, field, message });
});

export const checkContinuationHome = Effect.fn("HarnessContinuation.home")(function* (
  request: ChildRequest,
  home: Option.Option<string>,
  defaultHome: Option.Option<string>,
) {
  if (Option.isNone(request.resume)) return;
  const saved = request.resume.value;
  yield* checkContinuation(request, "cwd", Option.some(saved.cwd), Option.some(request.cwd));
  yield* checkContinuation(
    request,
    "home",
    Option.orElse(saved.home, () => defaultHome),
    home,
  );
});

export const environmentHome = (
  environment: Readonly<Record<string, string | undefined>>,
  variable: string,
  directory: string,
) => {
  const configured = (name: string) =>
    Option.fromNullishOr(environment[name]).pipe(Option.filter((value) => value.length > 0));
  const defaultHome = Option.map(configured("HOME"), (home) => `${home}/${directory}`);
  return {
    defaultHome,
    home: Option.orElse(configured(variable), () => defaultHome),
  };
};
