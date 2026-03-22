# Phase 3: Planner & Recording

> Status: IMPLEMENTED
> Depends on: Phase 2 (Scout & Explorer)

## Goal

Build the Planner agent that turns high-level test goals into step-by-step plans, executes them collaboratively with the Explorer, and records every action into replayable JSON. Also build the assertion engine.

## Design Decisions

| Decision | Choice |
|---|---|
| Planning strategy | Hybrid: generate full plan upfront, adapt step-by-step during execution |
| Preconditions | Planner generates setup steps (e.g., login) as part of the plan |
| LLM tier for planning | Balanced (Sonnet) for plan generation, Fast (Haiku) for element finding |
| Screenshots | Opt-in (off by default), stored in separate directory |
| Assertions | Soft by default (continue on failure, record result) |
| Parameters | Auto-detect during recording (email, password, username, numbers) |
| File naming | `{name-slugified}-{short-id}.json` |
| Visual baselines | Auto-capture on first run (Jest snapshot style) |
| Playwright export | Generate `.spec.ts` from recordings |
| Ignore dynamic regions | Mask with magenta pixels in visual regression |
| Custom assertions | LLM generates JS code, evaluates in page context |
| Step failure handling | Per-step: abort, skip, or retry (configured in plan) |

---

## Deliverables

### 3.1 Planner Agent (`src/agents/planner.ts`)

Takes a natural language goal + sitemap and produces a test plan, then executes it step-by-step with recording.

- `planTest(goal, sitemap)` — LLM generates full plan with steps, assertions, parameters, preconditions
- `refinePlan(plan, feedback)` — LLM adjusts plan based on execution feedback
- `executePlan(plan, options?)` — Collaborative execution loop:
  1. For each step: navigate if needed → find element via LLM → execute action → verify assertions
  2. Records every action to RecordingManager
  3. Auto-detects parameters and parameterizes the recording
  4. Saves recording to disk

**Collaborative element finding**: Uses LLM to resolve natural language descriptions ("the email input in the login form") to selector chains by observing current page elements.

**Types**:
- `TestPlan` — goal, preconditions, parameters, steps, assertions
- `TestStep` — action type, target description, value, expected outcome, failure strategy
- `PlannedAssertion` — type, target description, expected value, linked to step
- `ExecutionResult` — recording, success/failure counts, errors

### 3.2 Recording Manager (`src/state/recordings.ts`)

Captures every action during plan execution into structured JSON.

- `startRecording(name, baseUrl)` / `stopRecording()` — lifecycle
- `recordAction(action)` / `recordAssertion(assertion)` — capture
- `recordScreenshot(actionId, timing, buffer)` — optional screenshots
- `trackTokenUsage()` / `trackSelfHeal()` — metadata tracking
- `saveRecording()` / `loadRecording()` / `listRecordings()` / `deleteRecording()` — storage
- `buildSelectorChain(element)` — static, generates ordered selector chain (aria > testid > css > text)
- `detectParameters(recording)` — auto-detects email, password, username, numbers
- `parameterize(recording, params)` — replaces values with `{{param}}` templates
- `exportAsPlaywrightTest(recording)` — generates native `.spec.ts` file

### 3.3 Assertion Engines (`src/assertions/`)

#### Element Assertions (`element.ts`)
- `assertVisible` / `assertNotVisible` — element visibility
- `assertText` — text content contains expected
- `assertValue` — input value exact match
- `assertUrl` — URL regex/substring match
- `assertTitle` — title regex/substring match
- `assertElementCount` — count elements matching selector
- `assertAttribute` — attribute exact match

#### Visual Regression (`visual.ts`)
- `captureBaseline(page, name, region?)` — save baseline screenshot
- `compareToBaseline(page, name, options?)` — pixelmatch comparison
- `updateBaseline(page, name)` — update existing baseline
- Auto-captures baseline on first run
- Configurable threshold, ignore regions (masking), antialiasing tolerance
- Generates side-by-side diff images

#### Custom Assertions (`custom.ts`)
- `fromDescription(page, description)` — LLM generates JS assertion, evaluates in page context
- `register(name, fn)` / `run(name, page, params)` — reusable custom assertions
- Registry pattern for named, reusable checks

---

## File Structure

```
src/agents/
├── planner.ts           # PlannerAgent (plan generation + collaborative execution)
├── types.ts             # BaseAgent, AgentContext (Phase 2)
├── scout.ts             # ScoutAgent (Phase 2)
├── deep-explorer.ts     # DeepExplorerAgent (Phase 2)
└── orchestrator.ts      # Orchestrator (Phase 2)

src/state/
├── recordings.ts        # RecordingManager, Recording types
├── page-state.ts        # PageStateManager (Phase 1)
└── sitemap.ts           # SiteMapManager (Phase 1-2)

src/assertions/
├── element.ts           # ElementAssertionEngine
├── visual.ts            # VisualAssertionEngine (pixelmatch)
└── custom.ts            # CustomAssertionEngine (LLM-powered)
```

---

## Data Flow

```
User goal: "Test the signup flow"
        │
        ▼
   ┌─────────┐     ┌──────────┐
   │ Planner │────►│ Observer │  (find elements)
   │  Agent  │◄────│          │
   └────┬────┘     └──────────┘
        │
        ├─ Execute actions via ActionExecutor
        │
        ▼
   ┌──────────┐    ┌────────────────────┐
   │ Recording│───►│ .replaybot/        │
   │ Manager  │    │   recordings/      │
   └────┬─────┘    │   screenshots/     │
        │          └────────────────────┘
        ▼
   ┌──────────┐
   │Assertions│  (element, visual, custom)
   │  Engines │
   └──────────┘
```

## Phase 3 Exit Criteria

- [x] Planner generates a test plan from natural language goal + sitemap
- [x] Collaborative execution loop: navigate → find element → execute → assert
- [x] All actions recorded to JSON with full selector chains
- [x] Three assertion engines (element, visual, custom/LLM)
- [x] Recordings saved to `.replaybot/recordings/` as human-readable JSON
- [x] Parameters auto-detected and templateized in recordings
- [x] Playwright test export (`exportAsPlaywrightTest`)
- [x] Visual regression with pixelmatch (baselines, diffs, ignore regions)
- [x] TypeScript compiles cleanly
- [ ] All tests pass with mock LLM
