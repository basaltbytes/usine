# Supervisor permission requests

The browser test `apps/web/src/features/conversations/screenshots.browser.test.tsx` captures these views at 1280 × 900 and 390 × 844 pixels using the app's dark theme and reduced motion. Each view has a `-desktop.png` and a `-phone.png` file.

- `1297-request-waiting`: a turn that asked to retry a run and to upgrade the instance. The retry has **Allow once**, **Allow always for basaltbytes/usine**, and **Deny**; the upgrade needs admin access, which the signed-in operator lacks, so it has no answers.
- `1297-request-allowed`: the retry allowed once and run, with its folded result, then the outcomes message from usine and the supervisor's next answer.
- `1297-request-denied`: the retry denied by another member.
- `1297-grants`: **Configuration** > **Standing grants** for an admin: a grant in use, an inactive grant whose member lacks the access, and the allowed calls, one covered by a grant that failed and one allowed once that ran.

The conversations, requests, grants, members, and dates are test fixtures. The test runs no supervisor turn.
