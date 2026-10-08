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

**Option 1: npm (recommended)** — requires [Node.js ≥ 22](https://nodejs.org/):

```bash
npm i -g orosus
```

**Option 2: from source** — for development:

```bash
git clone https://github.com/zhangxyfs/Orosus.git
cd Orosus
pnpm install
```

### 2. Run

Type `orosus` (or `pnpm orosus` when installed from source).

To upgrade, run `orosus upgrade` — after confirmation it downloads, verifies and installs the new version globally; every launch also checks for updates automatically and shows a persistent banner line when one is available (toggle under `/settings → Update check`).

On first launch, if no provider is configured, the `/provider` wizard opens automatically — follow the menus to set up endpoint / API key / model, and modules reload automatically afterwards.

### 3. Daily Use

Type natural language to chat. Commands start with `/` (a menu pops up as you type, with your skills listed at the bottom); reference files with `@` — a directory menu opens as you type for step-by-step picking, and `@path#L10-L20` references line ranges. Alt+V pastes images, Alt+Enter / Shift+Enter breaks the line, Ctrl+O reviews compaction summaries, Ctrl+P opens the module launcher, and the mouse wheel scrolls the conversation directly (see `/help` for all shortcuts).

| Category | Command | Description |
|----------|---------|-------------|
| Sessions | `/new` `/fork` `/sessions` (`/resume`) `/title` (`/rename`) `/quit` | New session / fork / list & resume history / rename / quit |
| Session tree | `/session-tree__view` `/session-tree__branch` | Full-screen tree of project forks, Enter to jump / branch at the selected node |
| Model & state | `/model` `/effort` `/reload` `/help` | Switch model slot / reasoning-effort level / reload modules / help (the first two work mid-answer, next turn) |
| Module commands | `/compact` `/permission` `/yolo` `/auto` | Compact history / switch approval mode / one-shot ask-when-needed / never-ask mode |
| Side question | `/btw` | A quick side question with the current conversation context — the answer opens a small window and never enters the main flow (works mid-answer; no argument reopens the last one) |
| Subagents | `/tasks` (`/task`) | Subagent task list — Enter opens its message view (live refresh); rows with pending approvals can be answered right there |
| Settings | `/settings` (alias `/config`) | Disk / context / token usage, runtime status, subagent / skill / hook / MCP / memory management, vision-model & web-search setup, update-check toggle |

Skills: pick one from the skill section of the `/` menu (`skill : name`) and press Enter to load it as a user message; toggle with Alt+K under `/settings → Skills`. Eleven factory skills ship built-in (commit, code-review, research, doc-review, …).

## Features

- **Modular kernel**: five core pieces (session / loop / tool / provider / kernel) + the zero-dependency contracts package `@orosus/contracts`; modules activate in topological order, support hot reload, and degrade gracefully without blocking startup
- **Multi-provider**: a unified custom-endpoint entry (OpenAI-compatible) with an interactive `/provider` wizard and a built-in vendor catalog (endpoints / models / effort levels); switch at runtime with `/model` and `/effort`
- **Subagents**: the model delegates work into parallel sub-sessions via a spawn tool — foreground ones render as agent groups, background ones report back automatically when done; grandchild agents nest one level; `/tasks` lists them and answers their approvals; three fuses (turns / inactivity / total duration) end runaway agents with a wrap-up turn instead of a hard cut
- **Peer awareness & shared memory**: sessions in the same project see each other — occupancy queries, claims and releases keep parallel sessions from colliding; a shared memory store (write / list / read) crosses sessions, browsable via `/tool-peers__memory`; one-click import from existing Claude Code / ZCode / qwen-code / codex / DeepSeek-Reasonix memories
- **Skill system**: one `SKILL.md` per directory, pure knowledge — four search tracks (user/project × generic/brand), project overrides user on name clashes; the model loads on demand via `skill__load`, users load via the slash-menu skill section; toggle in `/settings`; eleven factory skills included
- **Hooks**: lifecycle shell hooks on seven events, protocol-compatible with Claude Code — existing hook scripts run unchanged: block risky commands, auto-approve safe ones, inject project knowledge into context, notify on completion; project-level hooks pass a sha256 trust gate plus a three-layer injection guard; manage under `/settings → Hooks`, inspect injections with Ctrl+H
- **Web access**: web search & fetch — native-search protocol faces / Tavily / Brave backends traversed automatically; searches work with zero configuration
- **Multimedia**: paste images with Alt+V or feed image / video files to the model directly; downsample / crop / convert / video-clip tools keep context costs down before reads; a vision-model channel lets non-multimodal models see images too
- **Tool ecosystem**: built-in modules for filesystem, shell (working-directory memory + background jobs), todo, ask; a Goal trio for long-running task continuation; ToolSearch for on-demand lookup in large tool sets; an MCP bridge (factory presets + add / toggle / trust confirmation in `/settings`)
- **Approval gate**: two-phase tool execution (declare → execute) with a `tool/pre-execute` waterfall interception point; three modes (ask-every-time / ask-when-needed / never-ask), user deny rules always win
- **Context management**: automatic & manual compaction, windowed reads with dedup/truncation, full-screen Ctrl+O summary review; true multimodal image input
- **Session tree**: `/fork` forks persist as a tree — view and jump branches with `/session-tree__view`, branch at any node with `/session-tree__branch`, scoped to the project
- **TUI**: full-screen takeover, streaming redraw, Markdown rendering (tables / code highlighting / LaTeX); keyboard and mouse both work — wheel scrolling, drag-select copies, double-click selects words, click opens URLs, scrollbar included; lazy-paged history (scrolling to the top loads earlier turns), tiered folding with Alt+E / O / F / S (thinking / tool details / error details / earlier steps)
- **Data self-governance**: sessions stored as readable, grep-able JSONL; `OROSUS_HOME` env var + `orosus home migrate` to relocate the entire data directory; module configs live one-file-per-module under `modules.d/`
- **Self-upgrade**: every launch checks for a newer version (failures stay silent and never block startup) and shows a persistent banner line when one is found; `orosus upgrade` self-upgrades in one command — streaming progress-bar tarball download, SRI verification, global install with npm/pnpm auto-detection; the automatic check can be turned off under `/settings → Update check` without affecting manual upgrades

## Repository Layout

```
Orosus/
├─ apps/cli/                    # The only frontend: REPL + subcommands (provider / module / sessions prune / home / upgrade)
├─ packages/
│  ├─ core/                     # Core five + kernel + diagnostics log + createHarness entry
│  ├─ contracts/                # Zero-dependency contracts: module / tool / provider / fs / home
│  ├─ testing/                  # Test infrastructure: fakeProvider / fakeModule, etc.
│  └─ modules/                  # Built-in modules (same kernel pipeline as external modules)
│     ├─ tool-fs/  tool-shell/  tool-todo/  tool-ask/      # Basic capabilities
│     ├─ tool-web/  tool-search/  tool-goal/  tool-subagent/  # Web / tool search / goal continuation / subagent spawn
│     ├─ tool-media/  tool-peers/                          # Multimedia (image / video) / peer awareness & shared memory
│     ├─ skill/  mcp/  session-tree/  hooks/               # Skills / MCP bridge / session tree / lifecycle hooks
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
| Architecture & technical overview | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Module developer guide (minimal module / contribution points / interception points) | [docs/developers.md](docs/developers.md) |
| Module walkthrough (build a real module from scratch) | [docs/module-walkthrough.md](docs/module-walkthrough.md) |
| Hooks reference (seven-event protocol) | [docs/hooks.md](docs/hooks.md) |
| MCP server reference | [docs/mcp-servers.md](docs/mcp-servers.md) |
| API docs (generated Markdown) | [docs/api/README.md](docs/api/README.md) |

## License

[MIT](LICENSE)
