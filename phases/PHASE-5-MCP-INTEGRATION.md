# Phase 5: MCP Integration

> Status: IMPLEMENTED
> Depends on: Phase 4 (Execution & Replay)

## Goal

Wire everything together as an MCP server that AI coding assistants can use as a tool. Define the tool interfaces, handle lifecycle, and build end-to-end integration tests.

## Design Decisions

| Decision | Choice | Confirmed |
|---|---|---|
| MCP resources | Yes — recordings list + sitemap as browsable resources | Yes |
| MCP prompts | Yes — explore-app, test-flow, regression-check | Yes |
| E2E testing | Mock in CI, real LLM smoke suite | Yes |
| Test app | Both — local app for CI, public site for smoke | Yes |
| Playwright install | Auto-install on first tool call | Yes |
| Entry point | Separate `src/server.ts` (library stays at `src/index.ts`) | Yes |
| Browser lifecycle | Lazy launch on first tool call, keep alive for session | Yes |
| License | MIT | Yes |
| Config | Env vars + optional `replaybot.config.json` file | — |

---

## Deliverables

### 5.1 MCP Server (`src/server.ts`)

Full MCP server with tools, resources, and prompts.

- `ReplaybotServer` class — manages browser lifecycle, agent context, tool dispatch
- **Lazy browser** — launched on first tool call that needs it, kept alive for session
- **Auto Playwright install** — checks/installs chromium on first use
- **Configuration** — env vars (`ANTHROPIC_API_KEY`, `REPLAYBOT_*`) or `replaybot.config.json`
- **Graceful shutdown** — saves state, closes browser on SIGINT/SIGTERM
- **Entry point** — `npx replaybot` or `node dist/server.js`

### 5.2 MCP Tools (9 tools)

| Tool | Description |
|---|---|
| `scout_app` | BFS exploration, builds sitemap |
| `explore_page` | Deep analysis of a single page |
| `plan_test` | NL goal → structured test plan |
| `execute_exploration` | Run test plan, record all actions |
| `replay_test` | Deterministic replay with self-healing |
| `create_replay` | NL → execution plan from saved recordings |
| `list_recordings` | List/filter saved recordings |
| `get_sitemap` | View discovered app structure (summary/detailed/graph) |
| `provide_credentials` | Supply auth credentials or storage state |

### 5.3 MCP Resources

| Resource URI | Description |
|---|---|
| `replaybot://recordings` | List of all saved recordings (JSON) |
| `replaybot://recordings/{id}` | Full recording details (JSON) |
| `replaybot://sitemap` | Discovered navigation graph (JSON) |

### 5.4 MCP Prompts

| Prompt | Description |
|---|---|
| `explore-app` | Guided flow: scout → deep explore → summarize |
| `test-flow` | Guided flow: scout → plan → approve → execute |
| `regression-check` | Replay all recordings, collect results |

### 5.5 Configuration

**Environment variables:**
- `ANTHROPIC_API_KEY` — LLM API key
- `REPLAYBOT_LLM_PROVIDER` — Provider name (default: anthropic)
- `REPLAYBOT_FAST_MODEL` / `REPLAYBOT_BALANCED_MODEL` / `REPLAYBOT_PREMIUM_MODEL`
- `REPLAYBOT_BROWSER` — chromium/firefox/webkit
- `REPLAYBOT_HEADLESS` — true/false
- `REPLAYBOT_STORAGE_DIR` — data directory (default: .replaybot)
- `REPLAYBOT_SELF_HEAL` — true/false
- `REPLAYBOT_TIMEOUT` — default action timeout ms

**Config file** (`replaybot.config.json`):
```json
{
  "llm": { "provider": "anthropic", "fastModel": "...", "apiKey": "..." },
  "browser": { "type": "chromium", "headless": true, "viewport": { "width": 1280, "height": 720 } },
  "storage": { "dir": ".replaybot", "screenshotsEnabled": true },
  "replay": { "selfHealEnabled": true, "defaultTimeout": 30000, "retryCount": 1 }
}
```

### 5.6 Client Configuration

**Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "replaybot": {
      "command": "npx",
      "args": ["replaybot"],
      "env": { "ANTHROPIC_API_KEY": "sk-..." }
    }
  }
}
```

### 5.7 Package Distribution

- `bin.replaybot` → `./dist/server.js`
- `main` → `./dist/index.js` (library exports)
- `types` → `./dist/index.d.ts`
- License: MIT

---

## File Structure

```
src/
├── server.ts              # MCP server entry point (bin)
├── index.ts               # Library exports (all phases)
├── agents/
│   ├── types.ts           # BaseAgent, AgentContext
│   ├── scout.ts           # ScoutAgent
│   ├── deep-explorer.ts   # DeepExplorerAgent
│   ├── orchestrator.ts    # Orchestrator
│   ├── planner.ts         # PlannerAgent
│   ├── execution.ts       # ExecutionAgent
│   └── replay.ts          # ReplayAgent
├── browser/
│   ├── controller.ts      # BrowserController
│   ├── observer.ts        # PageObserver
│   └── actions.ts         # ActionExecutor
├── llm/
│   └── interface.ts       # LLMClient, providers
├── state/
│   ├── page-state.ts      # PageStateManager
│   ├── sitemap.ts         # SiteMapManager
│   ├── recordings.ts      # RecordingManager
│   └── parameters.ts      # ParameterEngine
├── assertions/
│   ├── element.ts         # ElementAssertionEngine
│   ├── visual.ts          # VisualAssertionEngine
│   └── custom.ts          # CustomAssertionEngine
├── reporting/
│   └── generator.ts       # ReportGenerator
└── types/
    └── index.ts           # Shared types
```

---

## Phase 5 Exit Criteria

- [x] MCP server starts and accepts connections via stdio
- [x] All 9 tools callable and return structured results
- [x] MCP resources expose recordings and sitemap
- [x] MCP prompts guide common workflows
- [x] Lazy browser lifecycle (launch on first call, keep alive)
- [x] Auto Playwright browser install
- [x] Configuration via env vars and config file
- [x] Graceful shutdown with state persistence
- [x] `npx replaybot` launches the server
- [x] TypeScript compiles cleanly
- [ ] Integration tests cover core user journey
- [ ] E2E tests with local test app + public site smoke tests
