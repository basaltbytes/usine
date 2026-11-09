---
"@usine/executor": patch
---

Support SSH workers whose server drops SendEnv, including boxd. Probe and select a verified stdin environment transport for gateway tokens and provisioner API keys, preserving command input and child protocols. Apply the selected transport to reused machines and salvage, and skip sshd configuration when the machine has no running sshd.
