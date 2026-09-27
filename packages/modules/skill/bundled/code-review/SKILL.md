---
name: code-review
description: Review code changes (working diff, staged changes, or a PR) by delegating to a read-only sub-agent. Use when the user asks to review, critique, or sanity-check recent code changes — findings graded P0-P3, evidence-backed, "No findings." when clean.
when_to_use: Reviewing a diff, staged changes, or pull request before merge/commit
---

# Code Review

You are reviewing a set of code changes. Delegate the reading to a **read-only sub-agent** (role `research`) when the diff is large or spans unfamiliar files; review inline when it is small. Either way the report contract below is identical.

## Scope first

Determine what's under review: working tree diff (`git diff`), staged changes, or a PR/branch. Read the diff and enough surrounding code to judge changes in context — a one-line diff can be wrong only in context.

## Five-condition filter (what deserves a finding)

Report only issues that pass **all five**:

1. **Introduced by this change** — not pre-existing debt the diff merely touches.
2. **Demonstrable** — you can point at the exact lines and articulate the failure mode.
3. **Likely to be fixed** — the author would realistically act on it (blocking, correctness, or clearly worthwhile).
4. **Specific** — "error handling is weak" is not a finding; "timeout is never cleared on the error path at src/x.ts:42, leaking the timer" is.
5. **In scope** — within what the change claims to do, not a wishlist for the module.

## Grading

- **P0** — blocking: data loss, security hole, crash on a mainline path, or broken build/tests.
- **P1** — correctness bug on a real path; will bite soon.
- **P2** — should fix: edge case, misleading naming, missing test for changed behavior.
- **P3** — note: style/nit with low cost to fix; batch them, don't spam one per line.

## Report format

```
## Review: <scope in one line>

### P0
- src/x.ts:42 — <what> — <why it breaks> — <suggested fix>

### P1 / P2 / P3 (same shape)

### Verified
- <behaviors/paths you checked and found correct — say what you read>
```

If nothing passes the filter: write exactly `No findings.` plus the verified list. **Never fabricate findings to seem thorough** — an empty report with a real verified list is a good outcome.

## Constraints

- Read-only: do not modify files, do not commit, do not delegate further from the sub-agent.
- Tests: say whether you ran them; if you didn't, say so — don't imply green.
- Tone: factual, no verdicts about people. The finding list is the deliverable.
