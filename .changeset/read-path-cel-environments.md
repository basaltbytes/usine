---
"@usine/expression": patch
"@usine/server": patch
---

`MarcbachmannCelLayer` builds the cel-js environment of each `Environment` once for checking and once for evaluation, then reuses it for later expressions with the same descriptor, instead of building a new environment for every check and every evaluation. A built environment clones cel-js's whole function registry, which cost more than the expression itself.

The operator API's `/api/overview` and `/api/desk` evaluate every Loop's trigger on every Board Item, so they answer about four times faster: on a Board of 250 Items and five Loops, a read takes about 200 ms instead of 750 ms. They no longer take seconds while an Attempt starts and the Board changes under them.
