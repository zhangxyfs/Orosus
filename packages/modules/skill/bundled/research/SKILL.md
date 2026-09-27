---
name: research
description: Answer questions by joint verification — read the local code AND check external primary sources, then report conclusions with what was actually consulted. Use when the user asks to investigate how something works, whether a library/behavior claim holds, or wants a negative claim vetted ("does nothing do X?").
when_to_use: Questions needing code + external sources cross-checked; vetting negative claims
---

# Research

You are answering a question with **evidence from both sides**: the local repository and external primary sources (official docs, changelogs, source repos). Single-sided answers are where research goes wrong — code tells you what *this* version does; docs tell you what it *promises* across versions.

## Workflow

1. **Restate the question as something decidable.** "Is X possible?" → "find a code path or documented API in <specific target> that does X".
2. **Local side**: grep/glob to locate the relevant code; read enough to be accurate. Cite `file:line` for every behavior claim.
3. **External side**: check primary sources — the library's own docs/source/changelog, not blog posts or AI summaries of them. Cite the URL and the version you checked. When local and external disagree, that's a finding, not an error: report both and the versions.
4. **Cross-check**: does the external account change how to read the code (version drift, config-gated behavior, platform conditionals)?
5. **Report**, conclusion first.

## The negative-claim rule

Saying "**nothing does X**" (no such API, no config key, no implementation) is a strong claim — it asserts your search was complete. Every negative claim must be accompanied by **what you actually searched**:

```
No such option exists.
Searched: repo grep "x-option|X_OPTION" (0 hits outside tests);
checked upstream src/settings/*.ts at v4.2.1 (flag absent);
docs config reference v4.2 — no mention.
```

Without the search trace, write "I did not find X in ..." instead — scope honesty beats false completeness. A negative claim later overturned costs more trust than a hedged one.

## Sub-agent use

For large sweeps, delegate the read-only leg to a `research` sub-agent (it has fs read/glob/grep + web search/fetch, cannot write). Give it the decidable question and require file:line or URL anchors in its report. You still own the cross-check and the final wording — a sub-agent's "not found" is only as good as the search terms it lists; demand the trace.

## Report shape

```
<Conclusion in one or two sentences.>

Evidence:
- code: <file:line — what it shows>
- external: <URL/version — what it promises>
- discrepancies: <none | what differs and the versions involved>

Not determined: <questions this pass couldn't answer + what would be needed>
```
