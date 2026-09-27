---
name: goal-draft
description: Turn a vague user idea into a well-formed goal for the /goal tool — decidable success conditions, evidence requirements, boundaries, iteration loop, and stop rules. Use when the user says something like "help me define the goal" or hands you a fuzzy objective before starting /goal work.
when_to_use: Drafting or tightening a goal definition before handing it to the /goal tool
---

# Goal Draft

You are converting a fuzzy intention into a **decidable goal**. A goal is well-formed when a third party could look at the final state and the transcript and rule "done" or "not done" without asking the author. Everything here serves that test.

## Workflow: ask, don't narrate

Work through the five elements below. For each, if the user's input already answers it, extract and confirm in one line; if it doesn't, **ask a short pointed question** — offer 2-4 concrete options rather than an open essay prompt. One question at a time. Update the draft after each answer so the user always sees the current goal text.

## The five elements

1. **End state (终态)** — what is true when this is done, phrased as observable facts ("tests X pass", "page loads in <1s"), not activities ("work on performance").
2. **Proof (证明)** — what evidence demonstrates the end state, and where it comes from: a command output, a screenshot, a green CI run. Name the exact command or artifact.
3. **Boundaries (边界)** — what is explicitly out of scope: files/modules/behaviors this goal must not touch, plus non-goals the user would be tempted to sweep in.
4. **Loop (循环)** — how progress iterates: run → check evidence → adjust. Which checks run every iteration vs. at the end.
5. **Stop rules (停止规则)** — when to stop iterating even if not perfect: evidence met (success), N failed iterations with the same blocker (report blocked, don't spiral), or budget exhausted. Include the escape hatch verbatim: "if blocked for more than the iteration limit, stop and report what blocks you."

## Good vs. weak — calibrate by contrast

- Weak: "make the app faster" → Good: "cold start < 2s on the demo project, measured by `time orosus --version` three times consecutively".
- Weak: "improve test coverage" → Good: "branch coverage of packages/core/src/compaction ≥ 80% in `vitest --coverage` output; fixtures excluded; no test may assert on wall-clock timing".
- Weak: "clean up the code" → Good: "no `TODO` older than this goal remains in packages/modules/tool-fs; behavior unchanged per existing test suite".

## Common mistakes

| Mistake | Fix |
|---|---|
| Activity instead of outcome ("refactor X") | State what becomes true after ("X has no duplicated parsing paths; all tests pass") |
| Unfalsifiable proof ("works well") | Name the command and the number |
| Hidden scope ("and generally tidy up") | Move anything not required into Boundaries as an explicit non-goal |
| No stop rule | Add the blocked-iteration limit; unbounded loops are how goals eat a day |
| Testing implementation instead of behavior | Proof checks observable behavior; implementation details belong to the doer |

## Output

Produce the goal as a compact block the user can hand straight to `/goal`: one-line title, then the five elements as short labeled lines. Before finishing, run the decidability test yourself: could a stranger rule on this? If any element fails, ask the question that fixes it — don't paper over it.
