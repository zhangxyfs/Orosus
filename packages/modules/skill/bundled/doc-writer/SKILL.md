---
name: doc-writer
description: Write project markdown documents — plans, READMEs, walkthroughs, surveys, and review reports. Use when the user asks to draft or restructure any .md deliverable in this repository. Routers by document type to the right structure; points to the repo's authoritative doc conventions instead of restating them.
when_to_use: Drafting or restructuring any markdown deliverable (plan / README / walkthrough / survey / report)
---

# Doc Writer

You are writing a **markdown deliverable** for this repository. This skill is a router: identify the document type, follow its structure, and defer facts to authoritative sources — the document itself carries workflow, not duplicated truth.

## 1. Before writing

- **Identify the document type** from the user's request (table below). Ambiguous? Ask one short question — never guess between "plan" and "survey".
- **Find the authoritative sources.** Existing docs in `docs/`, the survey/plan files the user references, README conventions. Read them first; your document will link to them, not restate them.
- **Know the audience**: contributor-facing (walkthrough, plan) vs user-facing (README, tutorial). Tone follows.

## 2. Document type router

| Type | Trigger | Core structure |
|---|---|---|
| Plan (实施方按) | "写方案 / plan" | Header table (date, status, batch id, baseline) → one-line summary → current state with anchors → goals → design with decisions → task breakdown with estimates → decision points → risks → "next steps" section, always last |
| README | "写 README" | What this is (one paragraph) → quick start → configuration → pointers to deeper docs |
| Walkthrough | "写教程 / walkthrough" | Task-oriented, step by step, each step verifiable; commands the reader can copy-paste; "what you should see" checkpoints |
| Survey / research report | "调研 / survey" | Question first → per-source findings with file:line anchors → comparison tables → conclusions → what applies to us |
| Review report | "审查 / review" | Verdict first → findings graded (A blocker / B should-fix / C note) with evidence → verified-clean list |

## 3. Rules for this repo's docs (summary/pointer form)

These are conventions of **this** repository — the authoritative versions live in its doc guides; when they differ from what you wrote, they win:

- **Plain language.** Every table cell, every design note, every "not doing" entry must be readable without insider jargon. Spell out terms on first use; give the conclusion *plus* a one-line mechanism.
- **Plans end with a "next steps" section** — concrete ordered actions, not aspirations.
- **Plan filenames are three-part**: `date-batch-topic.md`. Missing the batch segment gets the doc sent back.
- **Claims need anchors.** Any "repo X does Y" statement carries a file:line pointer. If you cannot produce the anchor, mark the claim as unverified — do not blur it in.
- **Numbers must reconcile.** Task counts, test-count chains (from → to), decision-point tallies — recompute them at the end; a table that doesn't add up invalidates the whole doc.

## 4. Writing mechanics

- Open with the conclusion (TL;DR), then supporting sections. Readers triage; they don't read linearly.
- One idea per paragraph. Lists for enumerable facts, prose for reasoning.
- Cross-reference by path (`docs/foo.md#section`), never "see above" / "as mentioned earlier" — readers jump in from anywhere.
- Don't duplicate a table you can link. The doc's job is routing and workflow; the truth lives in its source.

## 5. Before calling it done

Re-read against the type's structure. Check: every claim anchored or marked unverified; numbers reconciled; plain-language pass done (no unexplained abbreviations); ends with next steps (plans) or conclusions (surveys). If the user supplied a review checklist, walk it item by item and say which passed.
