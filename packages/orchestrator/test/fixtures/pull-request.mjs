#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const recordPath = ".test-pull-request.json";
if (process.argv.includes("--preflight")) {
  const brain = JSON.parse(process.argv[process.argv.indexOf("--preflight") + 1]);
  process.stdout.write(JSON.stringify({ _tag: "HarnessReady", harness: brain.harness }) + "\n");
} else if (process.argv.includes("--protocol-version")) {
  process.stdout.write("6\n");
} else if (process.argv.includes("--github")) {
  const args = process.argv.slice(process.argv.indexOf("--github") + 1);
  if (args[0] !== "api") throw new Error("Expected structured GitHub API access");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (args.includes("--method")) {
    const pr = {
      number: 71,
      html_url: "https://github.com/acme/demo/pull/71",
      head: { sha: head },
    };
    writeFileSync(recordPath, JSON.stringify(pr));
    process.stdout.write(JSON.stringify(pr));
  } else {
    if (args[1] !== `repos/acme/demo/commits/${head}/pulls?per_page=100`) {
      throw new Error("Discovery must use the Attempt repository and final commit");
    }
    if (!args.includes("--paginate") || !args.includes("--slurp"))
      throw new Error("Expected all pages");
    if (process.argv.includes("--lookup-fails")) process.exit(1);
    const pr = JSON.parse(readFileSync(recordPath, "utf8"));
    process.stdout.write(
      JSON.stringify([[{ ...pr, number: 99, head: { sha: "f".repeat(40) } }], [pr, pr]]),
    );
  }
} else {
  const [
    { NodeRuntime, NodeServices },
    { AgentRuntime },
    { Effect, Layer, Logger },
    { ChildProcess, ChildProcessSpawner },
    { runHost },
    { stubLayer },
  ] = await Promise.all([
    import("@effect/platform-node"),
    import("../../../agents/dist/runtime.js"),
    import("effect"),
    import("effect/unstable/process"),
    import("@usine/run-host"),
    import("../../../run-host/dist/stub.js"),
  ]);
  const spawnerLayer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "gh")
          return real.spawn(command);
        return real.spawn(
          ChildProcess.make(process.execPath, [
            new URL(import.meta.url).pathname,
            "--github",
            ...command.args,
            ...(process.argv.includes("--lookup-fails") ? ["--lookup-fails"] : []),
          ]),
        );
      });
    }),
  );
  const agentLayer = Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const stub = yield* AgentRuntime;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = (name, args) =>
        spawner
          .exitCode(ChildProcess.make(name, args))
          .pipe(
            Effect.flatMap((code) =>
              Number(code) === 0 ? Effect.void : Effect.die(`${name} failed`),
            ),
          );
      return AgentRuntime.of({
        launch: (request) =>
          Effect.gen(function* () {
            if (!process.argv.includes("--update-pr")) {
              yield* command("git", [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "Implement the issue",
              ]);
            }
            yield* command("gh", [
              "api",
              `repos/${request.spec.repository}/pulls`,
              "--method",
              process.argv.includes("--update-pr") ? "PATCH" : "POST",
            ]);
            return yield* stub.launch(request);
          }),
      });
    }),
  ).pipe(Layer.provide(stubLayer()));
  NodeRuntime.runMain(
    runHost().pipe(
      Effect.provide(agentLayer),
      Effect.provide(spawnerLayer),
      Effect.provide(NodeServices.layer),
      Effect.provideService(Logger.LogToStderr, true),
    ),
  );
}
