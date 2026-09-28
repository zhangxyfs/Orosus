<p align="center">
  <img src="docs/assets/logo.png" alt="Orosus" width="480">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b> · <a href="docs/ROADMAP.md">Roadmap</a> · <a href="docs/developers.md">Developer Guide</a>
</p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-339933">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-monorepo-f69220">
  <img alt="platform" src="https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-0078d6">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center">
  <b>Orosus</b> is a modular AI coding-assistant CLI — written in TypeScript, running directly on Node 22+<br>
  (no build step required). It consists of a core kernel, a zero-dependency contracts package,<br>
  and a set of pluggable modules; built-in modules go through the same registration pipeline as external ones.
</p>

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/zhangxyfs/Orosus.git
cd Orosus
pnpm install
```

### 2. Run

```bash
pnpm orosus
```

On first launch, if no provider is configured, the `/provider` wizard opens automatically — follow the menus to set up endpoint / API key / model, and modules reload automatically afterwards.

### 3. Daily Use

Type natural language to chat. Commands start with `/` (press Tab after `/` to complete command names — the menu also lists your skills at the bottom; Tab after `@` completes file paths, `@path#L10-L20` references line ranges). Alt+V pastes images, Alt+Enter / Shift+Enter breaks the line, Ctrl+O reviews compaction summaries, and the mouse wheel scrolls the conversation directly.

| Category | Command | Description |
|----------|---------|-------------|
| Sessions | `/new` `/fork` `/sessions` (`/resume`) `/title` (`/rename`) `/quit` | New session / fork / list & resume history / rename / quit |
| Session tree | `/session-tree__view` `/session-tree__branch` | Full-screen tree of project forks, Enter to jump / branch at the selected node |
| Model & state | `/model` `/effort` `/reload` `/help` | Switch model slot / reasoning-effort level / reload modules / help (the first two work mid-answer, next turn) |
| Module commands | `/compact` `/permission` `/yolo` `/auto` | Compact history / switch approval mode / one-shot ask-when-needed / never-ask mode |
| Subagents | `/tasks` (`/task`) | Subagent task list — Enter opens its message view (live refresh); rows with pending approvals can be answered right there |
| Settings | `/settings` (alias `/config`) | Disk usage / context usage / token usage / runtime status / skill management / subagent config / web search setup |

Skills: pick one from the skill section of the `/` menu (`skill : name`) and press Enter to load it as a user message; toggle with Alt+K under `/settings → Skills`. Ten factory skills ship built-in (commit, code-review, research, doc-review, …).

## Features

- **Modular kernel**: five core pieces (session / loop / tool / provider / kernel) + the zero-dependency contracts package `@orosus/contracts`; modules activate in topological order, support hot reload, and degrade gracefully without blocking startup
- **Multi-provider**: a unified custom-endpoint entry (OpenAI-compatible) with an interactive `/provider` wizard and a built-in vendor catalog (endpoints / models / effort levels); switch at runtime with `/model` and `/effort`
- **Subagents**: the model delegates work into parallel sub-sessions via a spawn tool — foreground ones render as agent groups, background ones report back automatically when done; grandchild agents nest one level; `/tasks` lists them and answers their approvals; three fuses (turns / inactivity / total duration) end runaway agents with a wrap-up turn instead of a hard cut
- **Skill system**: one `SKILL.md` per directory, pure knowledge — four search tracks (user/project × generic/brand), project overrides user on name clashes; the model loads on demand via `skill__load`, users load via the slash-menu skill section; toggle in `/settings`; ten factory skills included
- **Web access**: web search & fetch — native-search protocol faces / Tavily / Brave backends traversed automatically; searches work with zero configuration
- **Tool ecosystem**: built-in modules for filesystem, shell (working-directory memory + background jobs), todo, ask; a Goal trio for long-running task continuation; ToolSearch for on-demand lookup in large tool sets; an MCP bridge
- **Approval gate**: two-phase tool execution (declare → execute) with a `tool/pre-execute` waterfall interception point; three modes (ask-every-time / ask-when-needed / never-ask), user deny rules always win
- **Context management**: automatic & manual compaction, windowed reads with dedup/truncation, full-screen Ctrl+O summary review; true multimodal image input
- **Session tree**: `/fork` forks persist as a tree — view and jump branches with `/session-tree__view`, branch at any node with `/session-tree__branch`, scoped to the project
- **TUI**: full-screen takeover, streaming redraw, Markdown rendering (tables / code highlighting / LaTeX); keyboard and mouse both work — wheel scrolling, drag-select copies, double-click selects words, click opens URLs, scrollbar included
- **Data self-governance**: sessions stored as readable, grep-able JSONL; `OROSUS_HOME` env var + `orosus home migrate` to relocate the entire data directory

## Repository Layout

```
Orosus/
├─ apps/cli/                    # The only frontend: REPL + subcommands (provider / module / sessions prune / home)
├─ packages/
│  ├─ core/                     # Core five + kernel + diagnostics log + createHarness entry
│  ├─ contracts/                # Zero-dependency contracts: module / tool / provider / fs / home
│  ├─ testing/                  # Test infrastructure: fakeProvider / fakeModule, etc.
│  └─ modules/                  # Built-in modules (same kernel pipeline as external modules)
│     ├─ tool-fs/  tool-shell/  tool-todo/  tool-ask/      # Basic capabilities
│     ├─ tool-web/  tool-search/  tool-goal/  tool-subagent/  # Web / tool search / goal continuation / subagent spawn
│     ├─ skill/  mcp/  session-tree/                       # Skills / MCP bridge / session tree
│     ├─ approval/  compaction/                            # Approval gate / context compaction
│     └─ provider-custom/                                  # Unified provider entry (OpenAI-compatible + wizard)
└─ tests/                       # Cross-package integration tests (module graph / trust gate / reload / ...)
```

## Development

```bash
pnpm test               # vitest — full test suite
pnpm typecheck          # tsc — repo-wide type checking
pnpm lint               # oxlint
pnpm check:boundaries   # package boundary checks (core must not import modules, etc.)
pnpm build              # tsdown — build all packages
pnpm gen-docs           # generate the API reference (docs/api, plain-language Markdown)
```

| Document | Location |
|----------|----------|
| Roadmap (single source of truth for what's next) | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Module developer guide (minimal module / contribution points / interception points) | [docs/developers.md](docs/developers.md) |
| API docs (generated Markdown) | [docs/api/README.md](docs/api/README.md) |

## License

[MIT](LICENSE)
