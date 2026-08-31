# @usine/executor

Worker execution for [usine](https://github.com/basaltbytes/usine). The platform-free package root defines five operations: preflight, prepare, launch, cancel, and cleanup. It also owns the credential provider and typed executor errors.

The Node adapter lives at `@usine/executor/local`. For each Attempt it:

- checks Git and the installed run-host protocol without changing worker state;
- updates a per-repository bare cache, then creates a detached worktree at the resolved revision;
- mints one repository credential and passes it only through the child process environment;
- exchanges protocol-v1 envelopes with `@usine/run-host` over newline-delimited standard input and output;
- interrupts cooperatively before a hard kill, then removes the worktree and wipes the credential.

`LocalExecutorOptions.runHost` can override the child command for another compatible host. The adapter otherwise launches the executable shipped by `@usine/run-host` and rejects a protocol-version mismatch during preflight.

The local layer requires Effect `FileSystem`, `Path`, and `ChildProcessSpawner` services plus a `CredentialProvider`. Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.
