---
"@usine/gateway": minor
---

A renamed or transferred repository's new name works through the gateway. If GitHub answers git's `/OWNER/REPO/info/refs` or the API's `/repos/OWNER/REPO` for the attached repository with a permanent redirect (301 or 308) to the same path under another owner or repository name, the gateway confirms the rename with GitHub's API and the attachment's credential: `/repos/OWNER/REPO` with the attached name must redirect to `/repositories/ID`, and the `full_name` of that repository must be the new name. The attachment then serves paths with the new name until it's detached or expires, and a renewal keeps the learned names. Other attachments, temporary redirects, redirects of anything else, such as a release download or `/repositories/ID/...`, and names that the API doesn't confirm teach no name. Each learned name logs `Learned the new name of an attached repository`, with `newName`, and each unconfirmed one logs `GitHub's API didn't confirm the new name of an attached repository` at warning level, with `newName` and the `reason`.

`LiveAttachment` lists the learned names in `newNames` and answers `serves(repository)`, and `Attachments` has `learnNewName`.
