---
"@usine/executor": patch
---

Send gateway tokens and provisioner API keys to SSH workers as an environment block on each command's standard input instead of OpenSSH `SendEnv`, so they reach boxd workers and stay out of the local SSH client's environment. Gateway preflight fails with a `gateway` capability error naming the variables that don't arrive. Tailnet gateway setup no longer configures sshd `AcceptEnv`.
