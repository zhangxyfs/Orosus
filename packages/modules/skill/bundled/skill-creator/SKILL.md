---
name: skill-creator
description: Create, improve, or update agent skills (SKILL.md files). Use when the user wants to author a new skill, refine an existing one, or learn how skills are structured — covers directories, frontmatter, progressive disclosure, and test-driven refinement.
when_to_use: Writing or revising any SKILL.md, or teaching someone how skills work
---

# Skill Creator

You are helping the user create or improve a **skill** — a directory with a `SKILL.md` file that teaches an agent a repeatable procedure. Skills are plain knowledge: no scripts, no setup, no runtime dependencies.

Figure out where the user is in the creation loop, then act on that step. The loop: **intent → draft → test → read output → improve** (repeat until good). Enter anywhere; don't redo steps they've already done.

## 1. Clarify intent first

Before writing anything, know:

- **What task should the skill cover?** Distill it from the current conversation when possible (the user is usually asking because they just did or watched the task). Only interview them when the intent is genuinely unclear.
- **Is it one skill or several?** If the procedure has distinct triggers ("write a doc" vs "review a doc"), split it.
- **New skill or update to an existing one?** Check the four scan directories before drafting (below). If a same-name skill exists, this is an update — keep its name.

## 2. Where skills live (Orosus scan order, weakest → strongest)

| Directory | Scope |
|---|---|
| bundled (ships with the app) | built-in, always overridable |
| `~/.agents/skills/` | personal, ecosystem-standard |
| `~/.orosus/skills/` | personal, Orosus-native |
| `<repo>/.agents/skills/` (cwd up to git root) | shared with everyone in the repo |
| `<repo-root>/.orosus/skills/` | shared, Orosus-native |

Later entries win on name collision (project beats personal; brand beats generic). Recommend `<repo>/.agents/skills/` for skills that should travel with the repo, `~/.agents/skills/` for personal ones. To **update** an existing skill without touching its source, copy it to a stronger directory and edit there.

## 3. SKILL.md anatomy

```markdown
---
name: kebab-case-identifier
description: One or two sentences, third person, saying BOTH what it does and WHEN to use it.
when_to_use: Short trigger phrase shown in the menu detail line (optional)
---

# Title

Body: the procedure, written for an agent that knows programming but not this task.
```

Rules that matter:

- **`description` is the match key.** The agent decides to load the skill by reading only name + description. Say what it does *and* when to reach for it ("Use when ..."). Vague descriptions are the #1 reason skills never fire.
- **`disable-model-invocation: true`** (value must be exactly `true`) keeps the skill out of the model's automatic list — user-only tool, still loadable from the menu.
- Unknown frontmatter keys are ignored. Don't invent new ones to carry behavior.

## 4. Progressive disclosure (the three layers)

- **Layer 1 — description** (always loaded, ~2 sentences). Must be enough to decide "not this skill" reliably.
- **Layer 2 — SKILL.md body** (loaded on demand). The full procedure. Keep under ~500 lines; if it swells, move detail into `references/` files.
- **Layer 3 — `references/*.md`** (read with the fs tools only when needed). Bulky material: checklists, long examples, per-dialect tables. Reference them by filename from the body ("see references/report-formats.md").

Every layer should make sense alone. Don't hide load-bearing instructions in layer 3.

## 5. Writing the body — examples beat rules

- Lead with a short "what this skill produces" statement, then the procedure as numbered steps or a small decision table.
- Show **one concrete good example** instead of three paragraphs of abstract rules. A worked input → output pair teaches faster than any adjective.
- State the environment honestly (commands, file locations, conventions of *this* repo) — don't write generic advice the model already knows.
- **What NOT to include**: secrets, absolute paths from someone's machine, session-specific context, prose the model could derive, and anything requiring scripts or installed tools. Skills are knowledge, not code.

## 6. Test before calling it done

Draft 2–3 realistic prompts a user might send that should trigger this skill, and prompts that *shouldn't*. For each: would the description win the match? Walk the body against one real task — can a competent agent follow it to a correct result without guessing? If the skill includes references, verify each referenced file exists.

## 7. Improve from evidence

When a test or real usage misses:

- Skill never fires → description problem: sharpen the "when to use" wording.
- Skill fires but agent does the wrong thing → body problem: the step that went wrong is under-specified — replace it with a concrete example.
- **Generalize from the failing example; don't stack on new rules.** Every fix should read like it was always there.

## 8. Updating an existing skill

Read the current version, make the smallest change that fixes the issue, keep the name (renaming breaks references and user habits). Confirm with the user before writing to disk when the skill isn't yours.
