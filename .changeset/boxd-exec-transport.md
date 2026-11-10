---
"@usine/agents": patch
"@usine/config": minor
"@usine/executor": minor
"@usine/server": minor
---

boxd workers run commands over boxd's gRPC `Exec` stream instead of SSH. A boxd worker needs only its API key: it refuses `identity_file`, and neither the boxd account nor the snapshot needs an SSH key. The executor runs each command through the boxd shell, a stand-in for `ssh` that raises the HTTP/2 window, sends stdin in small chunks, and sends keepalive pings, and it no longer pins a proxy host key or refreshes a proxy port. The `SshCommand` contract that stand-ins for `ssh` follow is documented where `SshCommand` is defined, and the Cloudflare sandbox shell shares its argument parsing, stream relay, and exit codes with the boxd shell.
