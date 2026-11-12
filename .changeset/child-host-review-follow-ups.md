---
"@usine/agents": minor
"@usine/executor": patch
"@usine/server": patch
---

`@usine/agents/child-host` exports `STDIN_ENVIRONMENT_PREFIX`, the start of a remote command line that reads the secret environment block from stdin, and the `HostInput` and `HostCommandOptions` types: a command on a host takes its input as a stream, so an `ExecShell` command no longer buffers a `"pipe"` input without a limit. An `ExecShell` command whose input stream fails reads end of file, also when `endOnDone` is `false`. `@usine/agents/harness` no longer exports `gatewayTokenVariables`, which had no caller.

When an SSH client exits with code 255, the executor logs it at debug instead of as a warning, so a booting machine that preflight or preparation polls no longer logs a warning on each try; the caller that handles the `HostUnreachable` error chooses the level. When the gateway preflight's check of the variables sent on stdin fails with output on stderr, the error's cause keeps the names of the variables that the machine didn't receive and the exit code next to the stderr.
