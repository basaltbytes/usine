---
"@usine/agents": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/server": minor
---

boxd workers run commands over boxd's gRPC `Exec` stream instead of SSH. A boxd worker needs only its API key: neither the boxd account nor the snapshot needs an SSH key, and a boxd worker that still sets `identity_file`, as earlier releases required, loads and ignores it, with a preflight warning that names the file. The executor runs boxd commands in its own process through a new `ExecShell` child host, with one HTTP/2 connection per worker that raises the receive windows, sends stdin in small chunks, and sends keepalive pings. A lost command is a typed `HostUnreachable` error instead of exit code 255. The executor reports an SSH client's exit code 255 as the same error, so a machine that SSH loses during a preflight or preparation check fails with a message that names the host and the SSH client's reason, and the executor no longer pins a proxy host key or refreshes a proxy port for boxd machines.
