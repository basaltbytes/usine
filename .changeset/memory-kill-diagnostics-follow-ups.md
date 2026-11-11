---
"@usine/core": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

SSH worker preflight with a container runtime now checks that the SSH user can read the host kernel journal or ring buffer. A missing permission appears under **Preflight findings** on the worker's page, with the fix, and doesn't block attempts. `PreflightReport` and `MachineCheck` have a `findings` field, and the worker configuration and preflight views return `findings`.

A container started again for a reason other than a memory kill now still records the processes the kernel killed before the start. The `dmesg` fallback filters `oom-kill:` lines on the worker instead of sending the whole ring buffer over SSH, the executor logs which kernel log it read, and Podman's cgroupfs container cgroups (`libpod-<id>`) match. Out-of-memory records keep at most `MAX_KILLED_PROCESSES` (20) processes, and their kill count includes the rest; older records keep their first 20 processes.

Attempt outcomes now name the killed-process list with its visible label, so screen readers announce it once. The **First time right** statistics hide the memory-kill line when the window has none.
