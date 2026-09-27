---
name: commit
description: Stage and commit changes with ledger discipline — status vs. the batch's expected file list, no over- or under-staging, and a pre-add grep for imports of untracked files. Use when the user asks to commit the current work or a specific batch of it.
when_to_use: Committing work — before any git add
---

# Commit

You are turning working-tree changes into a commit. The cardinal risk is **staging the wrong set**: over-staging sweeps in unrelated in-flight work; under-staging ships a commit that doesn't build from a fresh checkout (an import of an untracked file, a forgotten new file). Both count as incidents here.

## Procedure

1. **`git status` against the expected list.** The batch you're committing has a known file list (from the plan/task or the work you just did). Diff the two sets:
   - Files changed but **not** on the list → someone else's in-flight work or leftovers. Do **not** stage them; name them in your report. When in doubt, ask.
   - Files on the list showing **no** change → suspicious; either the work wasn't saved or the list is stale. Check before proceeding.
2. **Grep for untracked imports.** For each new file being committed, grep the staged sources for imports of files that are still untracked — an import of a never-committed module breaks every fresh checkout. Stage the imported files or drop the import.
3. **Stage exactly the list** — explicit paths, never `git add -A` / `.` in a tree with foreign changes. If hunks within a file belong to different efforts, stage only the right hunks.
4. **Message**: one-line summary (what + why-friction), body for anything non-obvious (a fix's root cause, a decision with a source anchor). Match the repo's existing message style.
5. **Post-commit verify**: `git show --stat HEAD` — the committed set must equal the intended list, nothing more.

## Checklist before pressing enter

- [ ] `git status` reconciled against the batch list (extra files named, missing files explained)
- [ ] grep found no imports of untracked files
- [ ] staged set = intended list exactly
- [ ] fresh-checkout test: could someone clone and build with exactly this commit's tree? (new files all staged, no dangling imports)
- [ ] message says what the change *is*, not what you did

## Known failure shapes (all real precedents)

- Over-staging: a sibling session's half-done work in the same tree rode along in `git add .`.
- Under-staging: a committed file imported a new helper file nobody staged — master broke on fresh checkout until the helper landed separately.
- Mixed hunks: two efforts' changes interleaved in one file got committed under one effort's message.
