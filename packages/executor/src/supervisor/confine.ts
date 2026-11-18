import { SupervisorUnavailable } from "@usine/agents/supervisor";
import { Effect, FileSystem, Option } from "effect";

const refused = (path: string, reason: string) =>
  SupervisorUnavailable.make({
    message: `Can't prepare the supervisor directory ${path}: ${reason}`,
  });

/**
 * Creates `path` and each missing directory between `root` and it, without following a symbolic
 * link. Fails when `path` isn't below `root`, has an empty, `.` or `..` segment, has an entry on
 * the way that is a link or not a directory, or resolves outside `root`.
 */
export const confinedDirectory = Effect.fn("SupervisorSandbox.confinedDirectory")(
  function* (fs: FileSystem.FileSystem, root: string, path: string) {
    if (!path.startsWith(`${root}/`)) return yield* refused(path, `it isn't below ${root}`);
    const segments = path.slice(root.length + 1).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
      return yield* refused(path, "it has an empty, . or .. segment");
    yield* fs.makeDirectory(root, { recursive: true });
    let current = root;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      const info = yield* fs.lstat(current).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(info)) yield* fs.makeDirectory(current);
      else if (info.value.type !== "Directory") {
        yield* Effect.logWarning("Refused a supervisor directory that isn't a plain directory", {
          path: current,
          type: info.value.type,
        });
        return yield* refused(path, `${current} is a ${info.value.type}, not a directory`);
      }
    }
    const resolvedRoot = yield* fs.realPath(root);
    const resolved = yield* fs.realPath(path);
    if (!resolved.startsWith(`${resolvedRoot}/`))
      return yield* refused(path, `it resolves to ${resolved}, outside ${resolvedRoot}`);
  },
  Effect.mapError((error) =>
    error._tag === "SupervisorUnavailable"
      ? error
      : SupervisorUnavailable.make({
          message: `Can't prepare a supervisor directory: ${error.message}`,
        }),
  ),
);
