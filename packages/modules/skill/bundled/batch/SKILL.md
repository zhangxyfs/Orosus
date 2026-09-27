---
name: batch
description: Apply the same transformation across many files — discover by glob, chunk the work, run workers in parallel, aggregate results, and dry-run before writing. Use when the user asks to apply one change "everywhere" or across a set of files ("rename this everywhere", "add the header to all modules").
when_to_use: One mechanical transformation applied to many files
---

# Batch

You are applying **one transformation to many targets**. The unit of correctness is the transformation, not the file — get it provably right on a sample before fanning out.

## Workflow

1. **Parse intent into a transformation.** One sentence: "for every file matching X, change Y". If the request is actually two transformations ("rename and also fix the imports"), split into two batch runs.
2. **Discover targets by glob** — never by memory. List the matches; eyeball the list for surprises (fixtures, snapshots, generated files, `node_modules`) and exclude them explicitly, saying what you excluded and why.
3. **Dry-run first.** Apply the transformation to **one representative target**, show the diff, and get the shape right (including edge shapes: empty match, multiple matches in one file, already-transformed file).
4. **Chunk the list** into groups (≈5-10 files per worker) — large enough to amortize startup, small enough that a failure costs one chunk.
5. **Fan out** to sub-agents (one per chunk, parallel) for mechanical changes at scale; do it inline when the whole set is <10 files or the edit needs judgment per file. Each worker gets: the exact transformation, its file list, and the instruction to report per-file outcome without inventing extra changes.
6. **Aggregate + verify.** Consolidate per-file results; then verify the whole set: re-glob and confirm the postcondition holds (e.g., zero remaining old names), run the relevant tests/lint if they exist.

## Safety rails

- **Dry-run is not optional** — no batch writes before the transformation proved itself on a sample and the user has seen the shape (or explicitly said go).
- **Write-only-what-was-asked**: workers apply the transformation; they do not reformat, re-order imports, or "improve" anything they touch.
- **Generated/vendor/snapshot files are excluded by default**; include them only when the user names them.
- **Failure containment**: a worker error marks its chunk failed — report which files, continue the rest, never retry silently in a loop.
- **Count reconciliation**: targets found = transformed + skipped(listed) + failed(listed). All three numbers appear in the final report.

## Report

```
Batch: <transformation in one line>
Targets: N discovered (excluded: M — <why>)
Done: K transformed, S unchanged (already in target state), F failed
Verification: <postcondition check result> ; tests: <ran/skipped + result>
```
