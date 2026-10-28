import { Effect } from "effect";
import type { CheckoutOps } from "./provision.ts";

const WRITE_FILE = String.raw`
set -e
mkdir -p "$(dirname "$1")"
umask 077
printf '%s' "$2" > "$1"
chmod "$3" "$1"
`.trim();

/** Reads scrubbed checkout files and writes private diagnostics or executable hooks. */
export const checkoutFiles = <E>(
  run: (
    operation: "prepare" | "cleanup",
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, E>,
): Pick<CheckoutOps<E>, "readFile" | "writeFile"> => ({
  readFile: (path) =>
    run("cleanup", "sh", ["-c", 'if test -f "$1"; then cat "$1"; fi', "sh", path]),
  writeFile: (path, content, mode) =>
    Effect.asVoid(run("prepare", "sh", ["-c", WRITE_FILE, "sh", path, content, mode])),
});
