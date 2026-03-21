# Phase 3: Planner & Recording

> Status: DRAFT — pending discussion
> Depends on: Phase 2 (Scout & Explorer)

## Goal

Build the Planner agent that turns high-level test goals into step-by-step plans, executes them collaboratively with the Explorer, and records every action into replayable JSON. Also build the assertion engine.

## Deliverables

### 3.1 Planner Agent (`src/agents/planner.ts`)

Takes a natural language goal and produces a test plan, then executes it step-by-step with Explorer feedback.

```typescript
interface PlannerAgent extends Agent {
  // Plan generation
  planTest(goal: string, sitemap: SiteMap): Promise<TestPlan>;

  // Collaborative execution
  executePlan(plan: TestPlan, explorer: ExplorerAgent): Promise<ExecutionResult>;

  // Plan refinement
  refinePlan(plan: TestPlan, feedback: string): Promise<TestPlan>;
}

interface TestPlan {
  id: string;
  goal: string;
  preconditions: string[];       // "user must be logged in", "cart must have items"
  parameters: ParameterDef[];    // Parameterizable values

  steps: TestStep[];
  assertions: PlannedAssertion[];
}

interface TestStep {
  id: string;
  order: number;
  description: string;           // "Fill in email field with test email"
  action: {
    type: ActionType;
    targetDescription: string;   // "the email input in the signup form"
    value?: string;              // "{{email}}" or literal value
  };
  expectedOutcome: string;       // "email field shows entered value"
  onFailure: 'abort' | 'skip' | 'retry';
  navigationRequired?: {
    from: string;                // Current expected page
    to: string;                  // Page where action happens
  };
}

interface PlannedAssertion {
  afterStepId: string;
  type: 'element_visible' | 'text_content' | 'url_match' | 'screenshot' | 'custom';
  description: string;           // "success message should be visible"
  targetDescription: string;     // "the success banner at top of page"
  expected: string;              // "Account created successfully"
}

interface ParameterDef {
  name: string;                  // "email"
  description: string;           // "User's email address for registration"
  type: 'string' | 'number' | 'boolean' | 'email' | 'password';
  defaultValue: string;
  constraints?: string;          // "valid email format"
}
```

**Collaborative execution loop**:
```
Planner                          Explorer
   │                                │
   ├─ Plan step 1 ─────────────────►│
   │                                ├─ Navigate if needed
   │                                ├─ Observe page state
   │                                ├─ Find target element
   │                                ├─ Execute action
   │◄─ Report: page state + result ─┤
   │                                │
   ├─ Verify outcome                │
   ├─ Adjust plan if needed         │
   ├─ Run assertion                 │
   │                                │
   ├─ Plan step 2 ─────────────────►│
   │                  ...           │
```

**LLM usage** (Sonnet/Opus-class):
- Break goal into ordered steps considering the sitemap
- Generate appropriate assertions for each step
- Identify parameters that should be configurable
- Detect preconditions from the goal description
- Adjust plan when Explorer reports unexpected page state

**Key decisions to discuss**:
- Should the Planner generate steps all at once, or one-at-a-time based on actual page state?
  - All-at-once: Faster, but may not match reality
  - One-at-a-time: Slower, more LLM calls, but adapts to actual state
  - Hybrid: Generate full plan, then adapt step-by-step during execution?
- How should the Planner handle preconditions? (e.g., "user must be logged in")
  - Option A: Planner generates login steps as part of the plan
  - Option B: Planner references a saved auth recording
  - Option C: Planner checks if precondition is met, asks user if not
- Should the Planner suggest negative test cases automatically? (e.g., "also test with invalid email")
- Max number of steps per plan? Should complex flows be broken into sub-plans?

---

### 3.2 Action Recording (`src/state/recordings.ts`)

Captures every action during exploration/plan execution into structured JSON.

```typescript
interface RecordingManager {
  // Recording lifecycle
  startRecording(name: string, baseUrl: string): Recording;
  stopRecording(): Recording;
  isRecording(): boolean;

  // Action capture
  recordAction(action: ActionRecord): void;
  recordAssertion(assertion: AssertionRecord): void;
  recordScreenshot(actionId: string, timing: 'before' | 'after', buffer: Buffer): Promise<string>;

  // Selector chain capture
  captureSelectors(page: Page, element: ElementHandle): Promise<SelectorChain>;

  // Parameter detection
  detectParameters(recording: Recording): ParameterDef[];
  parameterize(recording: Recording, params: ParameterDef[]): Recording;

  // Storage
  saveRecording(recording: Recording): Promise<string>;  // Returns file path
  loadRecording(id: string): Promise<Recording>;
  listRecordings(): Promise<RecordingSummary[]>;
  deleteRecording(id: string): Promise<void>;

  // Export
  exportAsPlaywrightTest(recording: Recording): string;  // Generate .spec.ts
}

interface Recording {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  base_url: string;
  parameters: ParameterDef[];
  actions: ActionRecord[];
  assertions: AssertionRecord[];
  sitemap_snapshot: Partial<SiteMap>;
  metadata: {
    duration_ms: number;
    agent_token_usage: { input: number; output: number };
    pages_visited: string[];
    self_healed_count: number;
  };
}
```

**Selector chain capture algorithm**:
When recording an action on an element, capture selectors in priority order:
1. Check for ARIA role + accessible name → `role=button[name="Submit"]`
2. Check for `data-testid` attribute → `[data-testid="submit-btn"]`
3. Generate minimal unique CSS selector → `form.signup button[type="submit"]`
4. Extract visible text content → `text="Sign Up"`
5. Generate XPath as fallback → `//form[@class='signup']//button`

Store all that succeed as the `SelectorChain` for the action.

**Key decisions to discuss**:
- Should recordings include screenshots by default, or opt-in? (Storage cost consideration)
- Screenshot storage: alongside JSON, or in a separate screenshots directory?
- Should we auto-detect parameters (e.g., "this looks like an email address, make it parameterizable")?
- Should recordings store the full page HTML snapshot for debugging?
- File naming convention: `recording-{id}.json` or `{name-slugified}.json`?
- Should there be a `exportAsPlaywrightTest()` that generates native `.spec.ts` files?

---

### 3.3 Assertion Engine (`src/assertions/`)

Multi-strategy assertion system: LLM-generated, visual regression, and user-defined.

#### Element Assertions (`src/assertions/element.ts`)

```typescript
interface ElementAssertionEngine {
  assertVisible(page: Page, selectors: SelectorChain): Promise<AssertionResult>;
  assertText(page: Page, selectors: SelectorChain, expected: string): Promise<AssertionResult>;
  assertValue(page: Page, selectors: SelectorChain, expected: string): Promise<AssertionResult>;
  assertUrl(page: Page, pattern: string): Promise<AssertionResult>;
  assertTitle(page: Page, expected: string): Promise<AssertionResult>;
  assertElementCount(page: Page, selectors: SelectorChain, count: number): Promise<AssertionResult>;
  assertAttribute(page: Page, selectors: SelectorChain, attr: string, expected: string): Promise<AssertionResult>;
}
```

#### Visual Regression (`src/assertions/visual.ts`)

```typescript
interface VisualAssertionEngine {
  // Baseline management
  captureBaseline(page: Page, name: string, region?: BoundingBox): Promise<string>;

  // Comparison
  compareToBaseline(page: Page, name: string, options?: CompareOptions): Promise<VisualDiff>;

  // Configuration
  setThreshold(percent: number): void;  // Acceptable pixel diff % (default: 0.1%)
}

interface VisualDiff {
  pass: boolean;
  diffPercent: number;
  diffPixelCount: number;
  diffImagePath: string;        // Side-by-side diff image
  baselinePath: string;
  actualPath: string;
}

interface CompareOptions {
  threshold: number;            // Per-pixel color diff threshold
  ignoreRegions: BoundingBox[]; // Areas to exclude (e.g., timestamps)
  antialiasing: boolean;        // Ignore antialiasing diffs
}
```

#### User-Defined / Custom Assertions (`src/assertions/custom.ts`)

```typescript
interface CustomAssertionEngine {
  // Natural language → assertion
  fromDescription(
    page: Page,
    description: string,        // "the shopping cart should show 3 items"
    llm: LLMProvider
  ): Promise<AssertionResult>;

  // Register reusable custom assertions
  register(name: string, fn: CustomAssertionFn): void;

  // Execute a registered assertion
  run(name: string, page: Page, params: Record<string, any>): Promise<AssertionResult>;
}

type CustomAssertionFn = (page: Page, params: Record<string, any>) => Promise<AssertionResult>;
```

**LLM-generated assertions** (during planning):
- Planner asks LLM: "After this action, what should we verify?"
- LLM responds with assertion type + selector + expected value
- Assertions are stored in the recording for deterministic replay

**Key decisions to discuss**:
- Should visual regression baselines auto-update on first run (like Jest snapshots)?
- How to handle dynamic content in visual regression (timestamps, avatars, ads)?
  - Masking regions? CSS injection to hide dynamic elements?
- Should custom assertions support JavaScript evaluation in the page context?
- Should assertions be "soft" (continue on failure) or "hard" (stop on failure) by default?
- Should we generate assertion descriptions that are human-readable in test reports?

---

## Data Flow (Phase 3)

```
User goal: "Test the signup flow"
        │
        ▼
   ┌─────────┐     ┌──────────┐
   │ Planner │────►│ Explorer │
   │  Agent  │◄────│  Agent   │
   └────┬────┘     └──────────┘
        │
        ▼
   ┌──────────┐    ┌────────────┐
   │ Recording│───►│ .replaybot/│
   │ Manager  │    │ recordings/│
   └────┬─────┘    └────────────┘
        │
        ▼
   ┌──────────┐
   │Assertions│
   │  Engine  │
   └──────────┘
```

## Testing Strategy (Phase 3)

- **Planner tests**: Mock LLM + mock Explorer to verify plan generation and collaborative loop
- **Recording tests**: Verify action capture, selector chain generation, parameterization
- **Assertion tests**:
  - Element assertions against test HTML pages
  - Visual regression with known baseline/diff images
  - Custom assertions with mock LLM
- **Integration test**: Full goal → plan → execute → record flow against test site

## Phase 3 Exit Criteria

- [ ] Planner generates a test plan from natural language goal + sitemap
- [ ] Collaborative Planner↔Explorer loop executes a multi-step plan
- [ ] All actions recorded to JSON with full selector chains
- [ ] Assertions generated and executed (element, visual, custom)
- [ ] Recordings saved to `.replaybot/recordings/` as human-readable JSON
- [ ] Parameters detected and templateized in recordings
- [ ] Screenshots captured before/after each action
- [ ] All tests pass
