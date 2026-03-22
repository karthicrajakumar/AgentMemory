# Phase 2: Scout & Explorer

> Status: IMPLEMENTED
> Depends on: Phase 1 (Foundation)

## Goal

Build the Explorer agent with its two sub-agents — Scout (fast BFS discovery) and Deep Explorer (detailed page analysis). By the end of this phase, Replaybot can autonomously map an application and build a rich understanding of each page.

## Design Decisions

| Decision | Choice |
|---|---|
| Agent communication | Direct method calls — no message bus |
| Scout scope | Links only (`<a>` tags) |
| Deep Explorer interaction | Observe + selective verify |
| Resumability | Persist frontier/state to disk |
| Error handling | Retry once, skip on failure |
| Per-agent budget | Scout: 50k tokens/5min, Deep Explorer: 100k tokens/10min |
| Auth handling | Accept credentials upfront, auto-login when login form detected |
| Deep analysis storage | Alongside sitemap (`deepAnalysis` field on `SiteMapPage`) |
| Page deduplication | DOM fingerprint dedup |
| Shared components | Auto-detect repeated DOM regions, deduplicate, analyze once |
| SPA transitions | Network idle + DOM settle |
| Page visiting | Sequential (single tab) |
| Screenshots | Every page Scout visits |
| LLM tiers | Haiku for Scout, Sonnet for Deep Explorer |

---

## Deliverables

### 2.1 Agent Base Types (`src/agents/types.ts`)

Shared interfaces and base behavior for all agents.

- **BaseAgent** — abstract base with `name`, `role`, `context`, `budget`
- **AgentContext** — shared resources (browser, observer, actions, llm, pageState, sitemap, credentials)
- **AgentBudget** — `maxTokens` + `maxTimeMs` per invocation
- **Credentials** — optional `username`/`email`/`password` for auto-login
- **AgentAbortError** / **AgentBudgetExceededError** — typed errors
- Built-in `checkAborted()`, `checkBudget()`, `withRetry()` helpers

### 2.2 Scout Agent (`src/agents/scout.ts`)

Fast, breadth-first page discovery using Haiku-tier LLM.

- `scoutApp(entryUrl, options?)` — full BFS exploration
- `scoutPage(url, options?)` — single page scout
- `expandFrontier()` — process next batch of frontier items
- **Auto-login** — when credentials provided and login form detected, fills email/username + password and submits
- **Shared component detection** — fingerprints semantic regions (header, nav, footer, aside) across pages. When same structure seen on 2+ pages, registers as SharedComponent in sitemap
- **Fingerprint dedup** — skips pages with identical DOM structure
- **Configurable** — maxPages, maxDepth, stayWithinDomain, include/exclude patterns, delay between pages

### 2.3 Deep Explorer Agent (`src/agents/deep-explorer.ts`)

Thorough analysis of individual pages using Sonnet-tier LLM.

- `explorePage(url, options?)` — deep analysis of a single page
- **Phase 1: Observe** — LLM analyzes simplified DOM and predicts interaction outcomes for every element
- **Phase 2: Selective verify** — for low/medium confidence predictions, actually clicks the element and compares outcome to prediction
- **Shared component skip** — skips analysis of DOM regions already analyzed as shared components
- **Produces**: `DeepPageAnalysis` with interaction map, form analyses, dynamic regions, suggested test scenarios
- **Budget-aware** — checks abort signal and time budget between operations

### 2.4 Orchestrator (`src/agents/orchestrator.ts`)

Coordinates Scout → Deep Explorer flow.

- `exploreApp(options)` — full exploration: Scout all pages, then Deep Explore selected pages
- `resumeExploration(options)` — load persisted state and continue
- **Page selection strategies**: `all`, `forms-and-interactive` (default), `forms-only`, `none`
- **Priority-based selection** — pages with forms get highest priority, then interactive pages
- **Callbacks** — `onPageScouted`, `onPageExplored`, `onStatus` for progress tracking
- **Error collection** — captures per-page errors without stopping exploration

### 2.5 Sitemap with Shared Components (`src/state/sitemap.ts`)

Extended sitemap with shared component tracking.

- **SharedComponent** — `id`, `name`, `fingerprint`, `selector`, `description`, `interactiveElements`, `links`, `analyzedAt`
- `addSharedComponent()` / `getSharedComponent()` / `getSharedComponentByFingerprint()`
- `getAllSharedComponents()` / `isSharedComponent()`
- Shared components serialized alongside sitemap in `.replaybot/sitemap.json`
- Merge supports shared components (union strategy)

---

## File Structure

```
src/agents/
├── types.ts           # BaseAgent, AgentContext, AgentBudget, Credentials
├── scout.ts           # ScoutAgent (BFS discovery + auto-login + shared component detection)
├── deep-explorer.ts   # DeepExplorerAgent (observe + selective verify)
└── orchestrator.ts    # Orchestrator (Scout → Deep Explorer coordination)

src/state/
├── page-state.ts      # PageStateManager (Phase 1)
└── sitemap.ts         # SiteMapManager + SharedComponent support
```

---

## Testing Strategy

- **Scout tests**: Against a local multi-page test site (served by a test fixture)
  - BFS traversal order, auth gate detection, URL filtering, auto-login, shared component detection
- **Deep Explorer tests**: Against specific test pages with known forms/elements
  - Form field analysis, interaction mapping, selective verification, shared component skipping
  - Uses mock LLM to verify prompt construction
- **Orchestrator tests**: Integration test with Scout + Deep Explorer
  - Page selection strategies, resume from persisted state, error handling
- **Sitemap tests**: Shared component CRUD, persistence, merge

## Phase 2 Exit Criteria

- [x] Scout can BFS-explore a multi-page site and build a sitemap
- [x] Scout detects auth-gated pages and auto-logs in with provided credentials
- [x] Scout detects and deduplicates shared components (nav, header, footer)
- [x] Deep Explorer produces rich page analysis with interaction maps
- [x] Deep Explorer selectively verifies low-confidence predictions
- [x] Deep Explorer skips shared components already analyzed
- [x] Orchestrator coordinates Scout → Deep Explorer flow with page prioritization
- [x] Orchestrator supports resume from persisted state
- [x] Sitemap persists to `.replaybot/sitemap.json` with shared components
- [x] TypeScript compiles cleanly
- [ ] All tests pass with mock LLM (no real API calls in CI)
