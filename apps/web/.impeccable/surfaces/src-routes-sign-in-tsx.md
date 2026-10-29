---
version: 1
slug: "src-routes-sign-in-tsx"
primary_target: "src/routes/sign-in.tsx"
related_targets: ["src/routes/members.tsx","src/routes/tokens.tsx","src/components/session-menu.tsx"]
---

## Scope

Operate: members sign in, manage instance membership, and revoke device access. These pages extend the existing usine UI and use its controls, typography, dark theme, and spacing.

## Direction contract

THESIS: Present access controls as short forms and readable rows. Sign-in has one GitHub action and the local recovery command.

OWN-WORLD: Use the existing background, muted text, border, and primary action tokens, with registry buttons and fields. Preserve the sidebar and page heading pattern.

STORY: A member signs in, sees who can access the instance, and can end access from a browser or device. Every member has admin access.

FIRST VIEWPORT: Sign-in is a narrow centered section. Members and tokens use the work panel, a 20px heading, and rows separated by hairlines. Members has the login field and Add member action above the list. Destructive actions reveal confirmation in the same row.

FORM: Existing application forms and lists; seed: none (unavailable). Confirmation changes the row in place without navigation or added motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance


## Finish review

Disposition: ship. Review performed in-thread because the task prohibits delegation.

- Persistence: existing `DESIGN.md` remains the visual authority. No new tokens or raster assets.
- Fidelity: sign-in, members, and tokens match the existing form, row, heading, and sidebar patterns at 1440px and 390px. The local preview uses synthetic member data. No horizontal overflow was detected.
- Ceiling: the Operate surface uses labeled forms, inline destructive confirmation, pending states, and readable metadata. No added ornament is needed.
- Material fixes: the one-time link now handles hash navigation on an already-open sign-in page; a browser regression test covers it. The mechanical detector reported no findings.
- Keep: existing controls, spacing, dark theme, and concise access-management copy.
