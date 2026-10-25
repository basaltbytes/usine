---
"@usine/gateway": minor
---

A renamed or transferred repository's new name works through the gateway. If GitHub answers a request whose path names the attached repository with a permanent redirect (301 or 308) to a path with another repository name, the attachment learns that name and serves paths with it until it's detached or expires. A renewal keeps the learned names. Other attachments, temporary redirects, and redirects of paths that name no repository, such as `/repositories/ID/...`, teach no name. Each learned name logs `Learned the new name of an attached repository`, with `newName`.

`LiveAttachment` lists the learned names in `newNames` and answers `serves(repository)`, and `Attachments` has `learnNewName`.
