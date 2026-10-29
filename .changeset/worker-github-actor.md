---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Show exe.dev attempts' GitHub label changes, comments, and reviews in the run reader. Match each attempt against its worker's bot identity and preserve operator board moves under the instance App.

`GitHubItemHistory.appChanges` now requires the writer's `BotLogin` as its fourth argument, and `Operator.githubChanges` takes the current instance before the run ID. Removed workers have unknown writers, so the reader logs and omits their agent changes. exe.dev VMs share an integration bot; another VM's writes in the same attempt window can be attributed to the attempt.
