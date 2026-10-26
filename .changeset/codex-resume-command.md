---
"@usine/server": patch
---

The run page's **Resume this session** command finds a Codex child's session in the attempt's own Codex home, which an attempt behind a gateway with `openai` in `llm_providers` gets: it sets `CODEX_HOME` to that directory before `codex resume`. For a child whose model requests used the gateway's credential, the line under the command says that the gateway credential isn't available from your shell, instead of naming the attempt's harness login.
