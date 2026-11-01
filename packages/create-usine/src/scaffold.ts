import { InstanceDirectory } from "@usine/core/instance";
import type { ReleaseVersion } from "@usine/core/upgrade";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { environmentTemplate } from "./environment.ts";

const Installer = Schema.Literals(["npm", "pnpm"]);
type Installer = typeof Installer.Type;

class ScaffoldError extends Schema.TaggedError<ScaffoldError>("create-usine/ScaffoldError")(
  "ScaffoldError",
  { directory: InstanceDirectory, message: Schema.String },
) {}

export const detectInstaller = Effect.fn("Scaffold.detectInstaller")(function* (
  directory: InstanceDirectory,
) {
  yield* Effect.annotateCurrentSpan({ directory });
  const userAgent = yield* Config.String("npm_config_user_agent").pipe(Config.withDefault("npm"));
  return yield* Schema.decodeUnknownEffect(Installer)(userAgent.split("/")[0]).pipe(
    Effect.mapError(
      () =>
        new ScaffoldError({
          directory,
          message: "Use npm create usine@latest <folder> or pnpm create usine <folder>.",
        }),
    ),
  );
});

export const scaffold = Effect.fn("Scaffold.create")(function* (
  directory: InstanceDirectory,
  serverVersion: ReleaseVersion,
  installer: Installer,
) {
  yield* Effect.annotateCurrentSpan({ directory, serverVersion, installer });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(directory)) {
    if ((yield* fs.readDirectory(directory)).length > 0) {
      yield* Effect.logWarning("Scaffold refused a nonempty folder", { directory });
      return yield* new ScaffoldError({ directory, message: "Choose a new or empty folder." });
    }
  } else {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  const manifest = {
    private: true,
    scripts: { usine: "usine" },
    dependencies: { "@usine/server": serverVersion },
    engines: { node: ">=22" },
  };
  yield* fs.writeFileString(
    path.join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  yield* fs.writeFileString(path.join(directory, ".gitignore"), ".usine/\nnode_modules/\n.env\n", {
    flag: "wx",
  });
  yield* fs.writeFileString(path.join(directory, ".env"), environmentTemplate, {
    flag: "wx",
    mode: 0o600,
  });
  yield* Effect.logInfo("Installing the pinned usine server", {
    directory,
    serverVersion,
    installer,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installArgs =
    installer === "pnpm" ? ["install", "--ignore-workspace"] : ["install", "--workspaces=false"];
  const installCommand = [installer, ...installArgs].join(" ");
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(installer, installArgs, {
      cwd: directory,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (exitCode !== 0) {
    yield* Effect.logError("Scaffold installation failed", { directory, installer, exitCode });
    return yield* new ScaffoldError({
      directory,
      message: `Installation exited with status ${exitCode}. Run ${installCommand} in this folder to retry.`,
    });
  }
  const lockfile = installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  if (!(yield* fs.exists(path.join(directory, lockfile)))) {
    yield* Effect.logError("Scaffold installation produced no lockfile", {
      directory,
      installer,
      lockfile,
    });
    return yield* new ScaffoldError({
      directory,
      message: `Installation did not write ${lockfile}. Enable lockfiles and run ${installCommand} in this folder.`,
    });
  }
  yield* Effect.logInfo("Runtime folder created", {
    directory,
    serverVersion,
    installer,
    lockfile,
  });
});
