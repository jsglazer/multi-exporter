# Vendored paged.js

`paged.polyfill.js` is a **vendored, patched** copy of the paged.js CSS Paged Media polyfill. It is injected verbatim into the preview webview; it is never imported into `src/core/`.

| | |
|---|---|
| Upstream package | `pagedjs` |
| Upstream version | `0.4.3` |
| Upstream file | `node_modules/pagedjs/dist/paged.polyfill.js` |
| Upstream sha256 | `f59f361802416c770d549a647958649af2cf6601999924bc00e4f507dad5269f` |
| Vendored sha256 | `6f001462fc5a339094d117c4484ab4599801cd78d549b3b80066406b7763554c` |
| License | MIT (Coko Foundation) |

## Why it is vendored rather than imported

Two upstream crashes abort pagination with an error that says nothing about the document being paginated. Both fixes are a handful of lines. Vendoring keeps them from being silently reverted by an `npm update`.

### `findElement-null-guard.patch`

`findElement` crashes on a null node at page boundaries — `node.getAttribute("data-ref")` throws a `TypeError` from inside the layout builder, aborting pagination with no useful error.

### `nth-of-type-following-double-remove.patch`

`NthOfType.onRule` and `Following.onRule` each remove the rule they rewrite. A selector list that matches both — one holding a `*-of-type` pseudo *and* a `+` combinator, e.g. `p:first-of-type, h1 + p { text-indent: 0 }`, which is what the Manuscript profile ships — is removed twice, and csstree's `List.remove` throws `item doesn't belong to list` out of the polisher before a single page is laid out. The patch makes the second removal a no-op.

The failure was doubly opaque: `executeJavaScript` re-raises any in-guest exception as `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: <message>`, so a stylesheet bug arrived looking like a dead renderer process.

## Re-vendoring

Re-apply both patches, in order, after any re-vendor:

```sh
cp node_modules/pagedjs/dist/paged.polyfill.js vendor/pagedjs/paged.polyfill.js
git apply vendor/pagedjs/findElement-null-guard.patch
git apply vendor/pagedjs/nth-of-type-following-double-remove.patch
npm test
```

Neither patch is guarded by a read-check alone. `tests/pagedjs-null-guard.test.ts` executes `findElement` against a null node, and `tests/pagedjs-double-remove-guard.test.ts` drives both `onRule` implementations over a rule item that has already been unlinked — so re-vendoring without a patch breaks the build, not just a review.
