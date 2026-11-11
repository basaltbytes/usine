---
"@usine/server": patch
---

The **Project not found** page no longer says that the repository is missing from `repos` in `usine.yaml`. On a board or task list, it names the project ID from the URL. On a legacy `/projects/<owner>/<name>` URL, it names the repository that no project includes. A run URL whose run belongs to another project shows **Run not found** and names the run and the project from the URL. Each page points to **Configuration > Projects**, where admins manage projects.
