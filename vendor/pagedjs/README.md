# Vendored paged.js

`paged.polyfill.js` is a **vendored, patched** copy of the paged.js CSS Paged Media polyfill. It is injected verbatim into the preview webview; it is never imported into `src/core/`.

| | |
|---|---|
| Upstream package | `pagedjs` |
| Upstream version | `0.4.3` |
| Upstream file | `node_modules/pagedjs/dist/paged.polyfill.js` |
| Upstream sha256 | `f59f361802416c770d549a647958649af2cf6601999924bc00e4f507dad5269f` |
| Vendored sha256 | `3fbf433c387aba9b8c593a804f8e9bc48b613c7cb45a9f6af341ec468afecfb0` |
| License | MIT (Coko Foundation) |

## Why it is vendored rather than imported

`findElement` crashes on a null node at page boundaries — `node.getAttribute("data-ref")` throws a `TypeError` from inside the layout builder, aborting pagination with no useful error. The fix is one line. Vendoring keeps the fix from being silently reverted by an `npm update`.

## The patch

`findElement-null-guard.patch` is the diff from the upstream file to the vendored one. Re-apply after any re-vendor:

```sh
cp node_modules/pagedjs/dist/paged.polyfill.js vendor/pagedjs/paged.polyfill.js
git apply vendor/pagedjs/findElement-null-guard.patch
npm test
```

The patch is **not** guarded by a read-check alone. `tests/pagedjs-null-guard.test.ts` extracts `findElement` from this file, executes it against a null node, and fails if the guard is missing — so re-vendoring without the patch breaks the build, not just a review.
