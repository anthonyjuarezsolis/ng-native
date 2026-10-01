---
__default__: patch
---

`background: var(--surface)` is read as `background-color`, the one part of the shorthand native has, rather than refused as a shorthand a token cannot be used in. A token that is no colour unsets it, as Chrome unsets the shorthand.
