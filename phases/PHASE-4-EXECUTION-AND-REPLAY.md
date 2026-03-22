# Phase 4: Execution & Replay

> Status: IMPLEMENTED
> Depends on: Phase 3 (Planner & Recording)

## Goal

Build the Execution agent (translates natural language into action sequences from saved data) and the Replay agent (deterministic playback without LLM). This is the phase where Replaybot becomes a testing tool — recordings become runnable tests.

## Design Decisions

| Decision | Choice | Confirmed |
|---|---|---|
| Multi-recording merge | Yes, full merge — interleave steps from different recordings | Yes |
| Stale pages | Warn and skip, continue with remaining steps | Yes |
| Dry run mode | Yes — show resolved plan for review before executing | Yes |
| Time-dependent actions | Manual breakpoints — pause execution, user resumes | Yes |
| Negative test auto-gen | No (decided in Phase 3) | Yes |
| Parallel replay | No, sequential only for v1 | Yes |
| Playwright trace | On failure only — generate trace JSON for debugging | Yes |
| Flaky selectors | Retry first (1-2 times with backoff), then self-heal via LLM | Yes |
| Cleanup/idempotent | No cleanup for v1 — user manages test data | Yes |
| Test data generation | Both rule-based + LLM for complex/contextual data | Yes |
| External data files | Yes, CSV and JSON support | Yes |
| Report formats | JSON + Markdown for v1 | Yes |
| MCP summary format | Both structured JSON + natural language narrative | Yes |

---

## Deliverables

### 4.1 Execution Agent (`src/agents/execution.ts`)

Synthesizes replayable action sequences from saved recordings and NL descriptions.

- `createExecution(description, options?)` — search recordings, merge relevant ones, resolve parameters via LLM
- `deriveExecution(recordingId, modifications, options?)` — modify an existing recording (skip steps, change params, adjust assertions)
- **Multi-recording merge** — LLM selects and orders recordings, skips irrelevant steps, interleaves into single plan
- **Stale page handling** — warns and skips actions targeting pages no longer in sitemap
- **Dry run** — set `options.dryRun = true` to get the plan without executing
- **Breakpoints** — LLM can mark actions that need manual intervention (email verification, etc.)
- **Navigation planning** — uses sitemap pathfinding to build navigation between pages

**Types**:
- `ExecutionPlan` — id, description, derivedFrom, parameters, actions, assertions, navigationPlan, breakpoints
- `ResolvedAction` — fully resolved action with selectors, values, page context, timeouts
- `ResolvedAssertion` — assertion with resolved selectors and baselines

### 4.2 Replay Agent (`src/agents/replay.ts`)

Deterministic playback engine. **No LLM at runtime** except self-healing fallback.

- `replay(plan, options?)` — full replay of an execution plan
- `replayRecording(recordingId, params?, options?)` — replay a saved recording directly
- `startSteppedReplay(plan, options?)` — interactive step-by-step debugging

**Replay flow** per action:
1. Verify page matches expected → navigate if needed (sitemap pathfinding)
2. Resolve selector via chain fallback (aria → testid → css → text → xpath)
3. Retry on failure (configurable count, with backoff)
4. Self-heal via LLM if all retries fail (flag for human review)
5. Execute action via ActionExecutor
6. Run attached assertions
7. Capture screenshots (on failure by default, every step optionally)

**Self-healing**: LLM observes current page elements and finds the best match for the original selector. Always flagged `requiresReview: true`.

**Stepped replay**: `next()`, `skip()`, `runToEnd()`, `abort()`, `getState()` for interactive debugging.

**Options**: headed/headless, slow motion, screenshot policy, video, timeout, self-heal toggle, retry count, abort-on-failure, browser type, viewport, breakpoint callback.

### 4.3 Parameterization Engine (`src/state/parameters.ts`)

Test data generation and external data loading.

- `generateTestData(params)` — rule-based generators (email, password, username, phone, name, string, number, boolean)
- `generateInvalidData(params)` — invalid/edge-case values for negative testing
- `generateContextualData(params, scenario)` — LLM-generated data for complex scenarios (falls back to rule-based)
- `createDataSet(params, count)` — N variations for data-driven testing
- `loadDataFile(filePath)` — load CSV or JSON parameter data files
- `resolveTemplate(template, params)` — resolve `{{param}}` templates

**Built-in generators**: email, password, username, phone, name, string, number, boolean
**Invalid generators**: for each type, provides common invalid values

### 4.4 Report Generator (`src/reporting/generator.ts`)

Test result reporting in JSON and Markdown.

- `toJSON(result)` — full structured JSON report
- `toMarkdown(result)` — human-readable report with tables, failed action details, self-healing report, artifacts
- `toMCPSummary(result)` — both structured JSON summary and natural language narrative for AI assistants
- `toHealingReport(result)` — dedicated report for self-healed selectors requiring review

---

## File Structure

```
src/agents/
├── execution.ts         # ExecutionAgent (NL → action sequence, multi-recording merge)
├── replay.ts            # ReplayAgent (deterministic playback, self-healing, stepped)
├── planner.ts           # PlannerAgent (Phase 3)
├── types.ts             # BaseAgent, AgentContext (Phase 2)
├── scout.ts             # ScoutAgent (Phase 2)
├── deep-explorer.ts     # DeepExplorerAgent (Phase 2)
└── orchestrator.ts      # Orchestrator (Phase 2)

src/state/
├── parameters.ts        # ParameterEngine (rule-based + LLM, CSV/JSON)
├── recordings.ts        # RecordingManager (Phase 3)
├── page-state.ts        # PageStateManager (Phase 1)
└── sitemap.ts           # SiteMapManager (Phase 1-2)

src/reporting/
└── generator.ts         # ReportGenerator (JSON, Markdown, MCP summary)

src/assertions/
├── element.ts           # ElementAssertionEngine (Phase 3)
├── visual.ts            # VisualAssertionEngine (Phase 3)
└── custom.ts            # CustomAssertionEngine (Phase 3)
```

---

## Data Flow

```
User: "Run the signup test with invalid email"
        │
        ▼
   ┌───────────┐
   │ Execution │──── searches ────► saved recordings
   │   Agent   │──── consults ────► sitemap
   │           │──── merges  ─────► multiple recordings
   └─────┬─────┘
         │ ExecutionPlan (with breakpoints)
         ▼
   ┌───────────┐
   │  Replay   │──── drives ──────► Playwright browser
   │   Agent   │──── retries ─────► selector chain fallback
   │           │──── self-heals ──► LLM (on failure only)
   │           │──── checks ──────► assertion engines
   └─────┬─────┘
         │ ReplayResult
         ▼
   ┌───────────┐
   │  Report   │──── JSON ────────► machine consumption
   │ Generator │──── Markdown ────► PR comments / humans
   │           │──── MCP ─────────► AI assistant summary
   └───────────┘
```

## Phase 4 Exit Criteria

- [x] Execution agent creates action sequences from NL descriptions
- [x] Execution agent merges multiple recordings into one plan
- [x] Execution agent supports dry run mode
- [x] Execution agent handles stale pages (warn and skip)
- [x] Execution agent supports manual breakpoints
- [x] Replay agent runs recordings deterministically without LLM
- [x] Selector chaining works with fallback through all strategies
- [x] Self-healing engages after retries fail, flags for review
- [x] Stepped replay for interactive debugging
- [x] Parameterization with rule-based + LLM generators
- [x] CSV/JSON external data file loading
- [x] Test results reported in JSON + Markdown
- [x] MCP summary with structured + narrative formats
- [x] TypeScript compiles cleanly
- [ ] All tests pass
