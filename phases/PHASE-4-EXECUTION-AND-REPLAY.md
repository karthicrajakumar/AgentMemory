# Phase 4: Execution & Replay

> Status: DRAFT — pending discussion
> Depends on: Phase 3 (Planner & Recording)

## Goal

Build the Execution agent (translates natural language into action sequences from saved data) and the Replay agent (deterministic playback without LLM). This is the phase where Replaybot becomes a testing tool — recordings become runnable tests.

## Deliverables

### 4.1 Execution Agent (`src/agents/execution.ts`)

Takes a natural language test description and synthesizes a replayable action sequence from saved exploration data and recordings.

```typescript
interface ExecutionAgent extends Agent {
  // Core function: NL → action sequence
  createExecution(
    description: string,
    options?: ExecutionOptions
  ): Promise<ExecutionPlan>;

  // From existing recording with modifications
  deriveExecution(
    recordingId: string,
    modifications: string      // "use a different email", "skip the newsletter step"
  ): Promise<ExecutionPlan>;
}

interface ExecutionOptions {
  parameters?: Record<string, string>;  // Override default parameter values
  recordings?: string[];                // Specific recordings to draw from
  maxSteps?: number;                    // Limit action count
  startUrl?: string;                    // Override starting URL
}

interface ExecutionPlan {
  id: string;
  description: string;
  derived_from: string[];               // Recording IDs used as source
  parameters: Record<string, string>;   // Resolved parameter values
  actions: ResolvedAction[];            // Ordered, ready for replay
  assertions: ResolvedAssertion[];
  navigation_plan: NavigationStep[];    // How to get between pages
}

interface ResolvedAction {
  id: string;
  order: number;
  type: ActionType;
  selectors: SelectorChain;
  value?: string;                       // Parameters already resolved: "test@example.com"
  page: {
    url: string;
    fingerprint: string;
  };
  waitBefore?: number;                  // ms to wait before action
  waitAfter?: number;                   // ms to wait after action
  timeout: number;                      // Max time to find element
}

interface ResolvedAssertion {
  afterActionId: string;
  type: AssertionType;
  selectors?: SelectorChain;
  expected?: string;
  screenshotBaseline?: string;          // Path to baseline image
  timeout: number;
}
```

**How the Execution Agent works**:
1. Receives NL description: "Test signup with an invalid email"
2. Searches saved recordings and sitemap for relevant data:
   - Finds "User signup flow" recording
   - Finds sitemap knowledge about the signup page
3. Synthesizes action sequence:
   - Uses recording as skeleton
   - Modifies parameters (email → invalid format)
   - Adjusts assertions (expect error message instead of success)
4. Resolves navigation:
   - Checks current page vs. first action's page
   - Uses sitemap to plan navigation path
5. Outputs `ExecutionPlan` ready for Replay agent

**LLM usage** (Sonnet-class):
- Match NL description to existing recordings (semantic search)
- Determine which parameters to modify
- Adjust assertions for the modified scenario
- Resolve ambiguities ("the signup page" → which URL?)

**Key decisions to discuss**:
- Should the Execution agent be able to combine steps from multiple recordings?
  - e.g., "login, then add item to cart" = login recording + cart recording
- How to handle recordings that reference pages that no longer exist?
- Should there be a "dry run" mode that shows the plan without executing?
- Should the agent generate negative/edge-case variations automatically?
- How to handle time-dependent actions (e.g., "wait for email verification")?

---

### 4.2 Replay Agent (`src/agents/replay.ts`)

Deterministic playback engine. **No LLM at runtime** (except for self-healing fallback).

```typescript
interface ReplayAgent extends Agent {
  // Core replay
  replay(
    plan: ExecutionPlan,
    options?: ReplayOptions
  ): Promise<ReplayResult>;

  // From saved recording directly
  replayRecording(
    recordingId: string,
    params?: Record<string, string>,
    options?: ReplayOptions
  ): Promise<ReplayResult>;

  // Step-by-step (debugging)
  startSteppedReplay(plan: ExecutionPlan): SteppedReplay;
}

interface ReplayOptions {
  headed: boolean;               // Show browser window (default: false)
  slowMotion: number;            // Delay between actions in ms (default: 0)
  screenshotOnFailure: boolean;  // Capture screenshot on assertion fail (default: true)
  screenshotEveryStep: boolean;  // Capture screenshot after every action (default: false)
  video: boolean;                // Record video of replay (default: false)
  timeout: number;               // Per-action timeout (default: 30000)
  selfHeal: boolean;             // Enable LLM self-healing on selector failure (default: true)
  selfHealModel: 'fast' | 'capable';  // Model tier for self-healing (default: 'fast')
  retryCount: number;            // Retry failed actions N times (default: 1)
  abortOnFailure: boolean;       // Stop on first failure (default: true)
  browserType: 'chromium' | 'firefox' | 'webkit';  // default: 'chromium'
  viewport: { width: number; height: number };
}

interface ReplayResult {
  id: string;
  plan_id: string;
  status: 'passed' | 'failed' | 'error' | 'self_healed';
  started_at: string;
  finished_at: string;
  duration_ms: number;

  // Per-action results
  actionResults: ActionReplayResult[];

  // Assertion results
  assertionResults: AssertionReplayResult[];

  // Self-healing report
  selfHealedActions: SelfHealReport[];

  // Artifacts
  screenshots: { actionId: string; path: string }[];
  videoPath?: string;
  tracePath?: string;            // Playwright trace file

  // Summary
  summary: {
    totalActions: number;
    passedActions: number;
    failedActions: number;
    selfHealedActions: number;
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
  };
}

interface ActionReplayResult {
  actionId: string;
  status: 'passed' | 'failed' | 'self_healed' | 'skipped';
  usedSelector: { strategy: string; value: string };
  duration_ms: number;
  error?: string;
  screenshotPath?: string;
}

interface SelfHealReport {
  actionId: string;
  originalSelectors: SelectorChain;
  healedSelector: { strategy: string; value: string };
  confidence: number;
  reasoning: string;
  requiresReview: boolean;       // Always true — human must confirm
}

// Stepped replay for debugging
interface SteppedReplay {
  currentStep(): ResolvedAction;
  next(): Promise<ActionReplayResult>;
  skip(): void;
  runToEnd(): Promise<ReplayResult>;
  abort(): Promise<ReplayResult>;
  getState(): { completed: number; remaining: number; currentPage: string };
}
```

**Replay execution flow**:
```
For each action in ExecutionPlan.actions:
  1. Verify current page matches expected page
     - If not: attempt navigation using sitemap paths
     - If still wrong: fail with "unexpected page state"

  2. Resolve selector (chain fallback):
     - Try selector[0] (ARIA) → found? → use it
     - Try selector[1] (testid) → found? → use it
     - Try selector[2] (CSS) → found? → use it
     - ...
     - All failed? → if selfHeal enabled:
       - Capture page state
       - Call LLM: "Element was previously at {selectors}. Current page: {state}. Find it."
       - LLM returns new selector → verify → use → flag for review
       - If LLM fails → fail action

  3. Execute action (click/type/navigate/etc.)
     - Apply waitBefore if set
     - Execute via ActionExecutor
     - Apply waitAfter if set

  4. Run assertions (if any attached to this action)
     - Element assertions: check visibility/text/value
     - Visual assertions: compare to baseline screenshot
     - Custom assertions: evaluate

  5. Capture artifacts (screenshots, timing)

  6. Record result
```

**Key decisions to discuss**:
- Should replay support parallel execution (multiple browsers for different parameter sets)?
- How to integrate with CI/CD? (Exit codes? JUnit XML reports? Custom reporter?)
- Should replay auto-generate a Playwright trace for debugging failures?
- How to handle flaky selectors that sometimes work, sometimes don't?
  - Retry with backoff? Mark as flaky in results?
- Should the stepped replay mode support a web UI for visual debugging?
- Should replays be idempotent? (e.g., clean up created data after test)

---

### 4.3 Parameterization Engine

Built into the recording/replay pipeline but detailed here.

```typescript
interface ParameterEngine {
  // Template resolution
  resolveTemplate(template: string, params: Record<string, string>): string;
  // e.g., "{{email}}" + {email: "test@x.com"} → "test@x.com"

  // Auto-detection during recording
  detectParameters(actions: ActionRecord[]): ParameterDef[];
  // Finds values that look like emails, passwords, names, etc.

  // Data generation
  generateTestData(params: ParameterDef[], scenario: string): Record<string, string>;
  // e.g., scenario="invalid" → {email: "not-an-email", password: "short"}

  // Data sets for batch replay
  createDataSet(params: ParameterDef[], count: number): Record<string, string>[];
  // Generates N variations for data-driven testing
}
```

**Key decisions to discuss**:
- Should parameter generation use an LLM or rule-based generators?
- Should we support data files (CSV/JSON) as parameter sources?
- How to handle dependent parameters? (e.g., "if country=US, state must be a US state")
- Should there be built-in generators for common types? (fake names, emails, addresses)

---

### 4.4 Test Result Reporting

```typescript
interface ReportGenerator {
  // Output formats
  toJSON(result: ReplayResult): string;
  toJUnitXML(result: ReplayResult): string;     // CI/CD integration
  toHTML(result: ReplayResult): string;          // Human-readable report
  toMarkdown(result: ReplayResult): string;      // For PR comments

  // Summary for MCP response
  toMCPSummary(result: ReplayResult): string;    // Concise text for AI assistant

  // Diff report when self-healing occurred
  toHealingReport(result: ReplayResult): string;
}
```

**Key decisions to discuss**:
- Which report formats are essential for v1?
- Should reports include embedded screenshots or reference external files?
- Should we post results as GitHub PR comments automatically?
- Should the MCP summary be structured (JSON) or natural language?

---

## Data Flow (Phase 4)

```
User (via AI assistant): "Run the signup test with invalid email"
        │
        ▼
   ┌───────────┐
   │ Execution │──── searches ────► saved recordings
   │   Agent   │──── consults ────► sitemap
   └─────┬─────┘
         │ ExecutionPlan
         ▼
   ┌───────────┐
   │  Replay   │──── drives ──────► Playwright browser
   │   Agent   │──── checks ──────► assertion engine
   └─────┬─────┘
         │ ReplayResult
         ▼
   ┌───────────┐
   │  Report   │──── outputs ─────► JSON / JUnit / HTML / Markdown
   │ Generator │
   └───────────┘
```

## Testing Strategy (Phase 4)

- **Execution agent tests**: Mock LLM + saved recordings → verify correct action sequence generation
- **Replay tests**: Pre-recorded JSON → replay against test site → verify outcomes
- **Self-healing tests**: Intentionally break selectors, verify LLM fallback works
- **Parameterization tests**: Template resolution, data generation, batch replay
- **Report tests**: Verify output format correctness

## Phase 4 Exit Criteria

- [ ] Execution agent creates action sequences from NL descriptions
- [ ] Replay agent runs recordings deterministically without LLM
- [ ] Selector chaining works with fallback through all strategies
- [ ] Self-healing engages on selector failure, flags for review
- [ ] Parameterization resolves templates in actions
- [ ] Test results reported in at least JSON + Markdown format
- [ ] Full loop works: record → parameterize → replay with different data
- [ ] All tests pass
