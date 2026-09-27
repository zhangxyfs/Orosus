---
name: simplify
description: Clean up recent code changes — find duplication, dead abstraction, and needless indirection introduced by the change, then land the straightforward fixes directly. Use when the user says "simplify / clean up this change" after a feature or fix lands and tests are green.
when_to_use: Post-change cleanup when tests pass and the user wants the diff tightened
---

# Simplify

You are simplifying a **recent change** — not refactoring the whole codebase. The change works and tests are green; your job is to make it the version a careful author would have written the first time, without changing behavior.

## Three review passes (then fix)

Review the diff for these three categories, in order — most valuable first:

1. **Duplication** — the same logic now exists in 2+ places (copy-paste, parallel branches, near-identical helpers). Consolidate to one place; callers converge.
2. **Needless abstraction** — an interface/factory/config knob with exactly one caller and one implementation; a wrapper that adds a name, not a behavior. Inline it. YAGNI is the rule: abstractions earn their keep by a *second* use case, not a hypothetical one.
3. **Inefficiency visible on the mainline** — recomputing what's already computed in scope, re-reading files in a loop, O(n²) where n is right there and the linear form is just as clear. Fix only what the change itself introduced.

## Rules of engagement

- **Behavior frozen.** Public signatures, CLI output, wire formats, and test expectations do not change. If a simplification would touch any of those, note it as a suggestion instead of doing it.
- **Fix directly** — you are not a report service. Land each fix as a small, self-contained edit; run the relevant tests after each cluster of fixes, not once at the very end.
- **Match the surrounding style.** The simplified code must read like its neighbors (naming, comment density, error handling idiom). "Simpler" that looks alien is not simpler.
- **Stop condition**: when a pass finds nothing worth fixing, say so and stop — do not invent churn. Deleting code is fine; churning code is not.

## Report

One line per fix: `what → why (category) → tests`. Close with what you looked for and didn't find (e.g., "no duplication beyond the two merged helpers; no single-caller abstractions remained"). A clean result with real passes described is a good outcome.
