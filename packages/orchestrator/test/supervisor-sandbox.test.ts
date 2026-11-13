import { assert, describe, it } from "@effect/vitest";
import { SupervisorUnavailable } from "@usine/agents/supervisor";
import { Effect, Logger, Option } from "effect";
import { reportSupervisorAvailability } from "../src/supervisor-sandbox.ts";

const warningsIn = (warnings: Array<unknown>) =>
  Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });

const unavailable = {
  unavailable: Option.some(
    SupervisorUnavailable.make({
      message:
        "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
    }),
  ),
  open: () => Effect.die("the test opens no sandbox"),
};

const available = { unavailable: Option.none(), open: unavailable.open };

describe("the supervisor's availability at startup", () => {
  it.effect("warns, with the reason, when the configured supervisor can't run", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      yield* reportSupervisorAvailability(true, unavailable).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      assert.deepStrictEqual(warnings, [
        [
          "The configured supervisor is unavailable on this orchestrator",
          {
            reason:
              "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
          },
        ],
      ]);
    }),
  );

  it.effect("doesn't warn without a configured supervisor, or when it can run", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      yield* reportSupervisorAvailability(false, unavailable).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      yield* reportSupervisorAvailability(true, available).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      assert.deepStrictEqual(warnings, []);
    }),
  );
});
