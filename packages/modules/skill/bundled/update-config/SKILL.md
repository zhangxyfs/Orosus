---
name: update-config
description: Guide safe edits to Orosus configuration files (config.toml, module enablement, provider/model/permission keys). Use when the user wants to change settings, fix a broken config, or wire a new module — quick-reference plus known pitfalls, with the authoritative sources linked.
when_to_use: Changing anything under config.toml / module enablement / provider wiring / permission keys
---

# Update Config

You are changing Orosus configuration. The quick reference below is a **summary**; the authoritative full documentation lives in `docs/developers.md` and the config guide in `docs/` — when anything here conflicts with those, those win. Read the current file before writing.

## Where things live

| Want to change | Location |
|---|---|
| Active provider / model slot | top-level `provider = "slot-name/model-id"` (first section of config.toml, **before any `[section]` header**) |
| Approval mode | `[approval] mode = "ask-always" / "ask-risky" / "never"` |
| Thinking effort | top-level `effort = "..."` |
| Module on/off | `[<module-name>] enabled = true/false` |
| Skills disabled list | `[skill] disabled = ["name-a", "name-b"]` |
| Subagent settings | `[tool-subagent] model / approvalMode / maxTurns` |
| TUI | `[tui] mode / sidebar / latex` |

User-level file: `~/.orosus/config.toml`. Project-level: `<repo>/.orosus/config.toml`.

## Known pitfalls (all bitten before — verify your write against these)

- **Line-level TOML writes must be section-aware.** Writing `provider = ...` without tracking sections once dropped the key into `[approval]` and broke startup. When editing line-by-line: a top-level key must be inserted **before the first `[section]` header**; a section key must land inside its own section.
- **Windows config files may carry a UTF-8 BOM** — strip it before parsing, don't write it back.
- **`setx` only affects new processes** — after env-var changes, already-open terminals read stale values.
- **`$ENV` placeholders are not resolved recursively in nested objects** — a literal `"$KEY"` string sent as an API key produces 401s. Expand env references one level at write time if that's the intent.
- **Changing host code (apps/cli) requires restarting the CLI** — `/reload` only reloads modules, never the host.

## Module enablement

Toggling a module = write `[<name>] enabled = ...` then reload. Hard rules: `orosus-core` and `approval` are locked (core body / safety rail — loosening approval goes through `/permission never`, not through unloading the module). The currently active provider module cannot be unloaded while in use. Modules with running/queued subagents refuse unload — resolve those first.

## Procedure

1. Read the current config file (the one you're about to edit) — never edit blind.
2. State the intended change in one line and the exact key(s) involved.
3. Apply the minimal edit, preserving comments, key order, and line endings (section-aware if line-level).
4. Verify: re-read the file, confirm the key landed in the right section and no other key moved.
5. Tell the user what takes effect when: immediate on next turn (model/effort/permission), on `/reload` (module enablement), or on restart (host-side settings).
6. If startup breaks: the error names the file — revert your last key move first, it's the highest-probability cause.
