---
"@usine/server": minor
---

Every `usine` command reads `.env` in the instance folder when it starts, so `usine restart` and `usine upgrade` work from a shell that doesn't set a gateway's admin token or the other variables that `usine up` reads. As with dotenv, a variable that the environment sets keeps its value, and `.env` sets the others. usine doesn't expand variables or run commands in `.env`, and doesn't pass its variables to child processes beyond their allowlists. A `.env` that exists but can't be read stops the command with status 1.
