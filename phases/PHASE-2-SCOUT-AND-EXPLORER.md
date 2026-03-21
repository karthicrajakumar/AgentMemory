# Phase 2: Scout & Explorer

> Status: DRAFT — pending discussion
> Depends on: Phase 1 (Foundation)

## Goal

Build the Explorer agent with its two sub-agents — Scout (fast BFS discovery) and Deep Explorer (detailed page analysis). By the end of this phase, Replaybot can autonomously map an application and build a rich understanding of each page.

## Deliverables

### 2.1 Agent Base Types (`src/agents/types.ts`)

Shared interfaces and base behavior for all agents.

```typescript
interface Agent {
  name: string;
  role: string;

  // Every agent is page-aware
  getCurrentPage(): PageState;
  getTargetPage(): string | null;

  // Communication between agents
  sendMessage(to: Agent, message: AgentMessage): Promise<AgentMessage>;
  onMessage(handler: (message: AgentMessage) => Promise<AgentMessage>): void;
}

interface AgentMessage {
  from: string;
  type: 'request' | 'response' | 'status' | 'auth_required';
  content: any;
  timestamp: string;
}

// Agent execution context — shared resources
interface AgentContext {
  browser: BrowserController;
  observer: PageObserver;
  actions: ActionExecutor;
  llm: LLMProvider;
  pageState: PageStateManager;
  sitemap: SiteMapManager;
  config: ReplaybotConfig;
}
```

**Key decisions to discuss**:
- Should agents communicate via direct method calls or via a message bus/event system?
- Should agent execution be cancellable (e.g., user aborts exploration)?
- How to handle agent errors — retry? escalate to the calling agent?
- Should there be a max budget (tokens/time) per agent invocation?

---

### 2.2 Scout Agent (`src/agents/scout.ts`)

Fast, breadth-first page discovery using a cheap/fast model (Haiku-class).

```typescript
interface ScoutAgent extends Agent {
  // Primary function
  scoutApp(entryUrl: string, options?: ScoutOptions): Promise<SiteMap>;

  // Incremental scouting
  scoutPage(url: string): Promise<ScoutPageResult>;
  expandFrontier(): Promise<ScoutPageResult[]>;  // Visit next unvisited pages
}

interface ScoutOptions {
  maxPages: number;            // Stop after N pages discovered (default: 50)
  maxDepth: number;            // Max clicks from entry page (default: 5)
  stayWithinDomain: boolean;   // Don't follow external links (default: true)
  excludePatterns: string[];   // URL patterns to skip (e.g., '/admin/*')
  includePatterns: string[];   // Only visit URLs matching these patterns
  timeout: number;             // Max total time in ms (default: 300000 = 5min)
}

interface ScoutPageResult {
  url: string;
  title: string;
  fingerprint: string;
  linksFound: LinkElement[];
  formsFound: FormField[];
  interactiveElements: InteractiveElement[];
  isAuthGated: boolean;
  authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  screenshotPath: string;
}
```

**Scout BFS algorithm**:
1. Visit entry URL → observe page → extract links + interactive elements
2. Add discovered URLs to frontier queue (BFS order)
3. For each URL in frontier:
   - Navigate → observe → extract
   - If auth-gated: pause, report to caller, await credentials
   - Record page in sitemap
   - Add new links to frontier
4. Continue until maxPages, maxDepth, or timeout reached
5. Return completed SiteMap

**LLM usage** (Haiku-class, minimal prompts):
- Classify page type: "login", "form", "listing", "detail", "dashboard", etc.
- Detect auth gates: "Does this page require authentication?"
- Generate page description: one-line summary of page purpose

**Key decisions to discuss**:
- Should Scout interact with pages (click buttons, open dropdowns) or only follow links?
- How to handle infinite scroll / lazy-loaded content?
- Should Scout detect and skip duplicate pages (same content, different URL)?
- Rate limiting between page visits to avoid overwhelming the target app?
- Should Scout attempt to identify API endpoints from network requests?

---

### 2.3 Deep Explorer Agent (`src/agents/deep-explorer.ts`)

Thorough analysis of a specific page or flow using a capable model.

```typescript
interface DeepExplorerAgent extends Agent {
  // Explore a single page in depth
  explorePage(url: string): Promise<DeepPageAnalysis>;

  // Explore a multi-step flow (e.g., "the checkout process")
  exploreFlow(startUrl: string, flowDescription: string): Promise<FlowAnalysis>;

  // Explore a specific element in detail
  exploreElement(selector: SelectorChain): Promise<ElementAnalysis>;
}

interface DeepPageAnalysis {
  url: string;
  fingerprint: string;
  pageType: string;              // 'form', 'dashboard', 'listing', etc.
  purpose: string;               // LLM-generated description
  interactionMap: InteractionMap; // What can be done on this page

  forms: FormAnalysis[];
  navigation: NavigationAnalysis;
  dynamicRegions: DynamicRegion[];  // Parts that change (SPA states)
  validationRules: ValidationRule[];  // Detected input validation

  suggestedTestScenarios: string[];  // LLM-suggested things to test
}

interface InteractionMap {
  actions: Array<{
    element: InteractiveElement;
    selectors: SelectorChain;
    expectedOutcome: string;     // LLM prediction: "opens modal", "submits form"
    sideEffects: string[];       // "sends email", "creates account"
    stateChanges: string[];      // "shows success message", "navigates to /dashboard"
  }>;
}

interface FormAnalysis {
  selector: SelectorChain;
  purpose: string;               // "user registration", "search", "contact"
  fields: Array<{
    name: string;
    type: string;                // 'email', 'password', 'text', 'select', etc.
    required: boolean;
    validationRules: string[];   // "min 8 chars", "must contain number"
    selectors: SelectorChain;
    suggestedTestValues: {
      valid: string;
      invalid: string[];         // Edge cases to test
    };
  }>;
  submitButton: SelectorChain;
  expectedSuccessIndicator: string;  // What signals successful submission
  expectedErrorIndicator: string;
}

interface DynamicRegion {
  description: string;
  triggerAction: string;         // "click tab", "scroll down"
  triggerSelector: SelectorChain;
  resultFingerprint: string;     // DOM fingerprint of the resulting state
}
```

**LLM usage** (Sonnet/Opus-class, rich prompts with screenshots + a11y tree + DOM):
- Full page semantic analysis
- Form field purpose detection and test value generation
- Interaction outcome prediction
- Validation rule detection
- Test scenario suggestion

**Key decisions to discuss**:
- How much should Deep Explorer actually interact with the page vs. just observe?
  - Option A: Observe only, predict outcomes
  - Option B: Actually click/type to verify predictions, then undo/reset
  - Option C: Observe first, then selectively verify high-uncertainty predictions
- Should it generate selector chains at analysis time, or defer to action time?
- How to handle pages that require specific preconditions (e.g., items in cart)?
- Should the analysis include performance observations (slow loads, animations)?

---

### 2.4 Explorer Orchestrator (`src/agents/explorer.ts`)

Coordinates Scout and Deep Explorer. Decides when to scout broadly vs. go deep.

```typescript
interface ExplorerAgent extends Agent {
  // Full exploration
  explore(entryUrl: string, options?: ExploreOptions): Promise<ExplorationResult>;

  // Targeted exploration
  exploreArea(urls: string[], depth: 'scout' | 'deep'): Promise<ExplorationResult>;

  // Get current knowledge
  getSiteMap(): SiteMap;
  getPageAnalysis(url: string): DeepPageAnalysis | null;
}

interface ExploreOptions extends ScoutOptions {
  deepExplorePages: 'all' | 'forms_only' | 'interactive_only' | 'none';
  deepExploreLimit: number;    // Max pages to deep-explore (default: 10)
  prioritize: 'forms' | 'navigation' | 'breadth';  // What to deep-explore first
}
```

**Orchestration flow**:
1. Run Scout to build initial sitemap
2. Analyze sitemap to prioritize pages for deep exploration
   - Forms and interactive pages get highest priority
   - Auth-gated pages flagged for credential handling
3. Run Deep Explorer on prioritized pages
4. Update sitemap with deep knowledge
5. If Scout discovered new pages during deep exploration, loop back

**Key decisions to discuss**:
- Should exploration be resumable (e.g., stop and continue later)?
- How to handle the credential prompt flow when Scout hits auth gates?
  - MCP response with `auth_required` type? Wait for next tool call with credentials?
- Should the orchestrator run Scout and Deep Explorer concurrently on different pages?

---

### 2.5 Sitemap Persistence (`src/state/sitemap.ts`)

Store and retrieve the navigation graph.

```typescript
interface SiteMapManager {
  // CRUD
  getSiteMap(): SiteMap;
  addPage(page: SiteMapPage): void;
  addEdge(edge: SiteMapEdge): void;
  updatePage(url: string, updates: Partial<SiteMapPage>): void;

  // Querying
  getPage(url: string): SiteMapPage | null;
  findPath(from: string, to: string): SiteMapEdge[];  // Shortest path
  getUnvisitedPages(): string[];
  getAuthGatedPages(): SiteMapPage[];

  // Persistence
  save(path: string): Promise<void>;   // Save to .replaybot/sitemap.json
  load(path: string): Promise<void>;   // Load from disk
  merge(other: SiteMap): void;         // Merge with another sitemap (team sharing)

  // SPA support
  addVirtualPage(parentUrl: string, virtualPage: VirtualPage): void;
  getVirtualPages(url: string): VirtualPage[];
}
```

**Key decisions to discuss**:
- Auto-save after every change, or explicit save?
- Should we store deep analysis alongside the sitemap or separately?
- Merge strategy when two team members have different sitemaps for the same app?

---

## Testing Strategy (Phase 2)

- **Scout tests**: Against a local multi-page test site (served by a test fixture)
  - Verifies BFS traversal order
  - Verifies auth gate detection
  - Verifies URL filtering (include/exclude patterns)
- **Deep Explorer tests**: Against specific test pages with known forms/elements
  - Verifies form field detection
  - Verifies selector chain generation
  - Uses mock LLM to verify prompt construction
- **Explorer orchestrator tests**: Integration test with Scout + Deep Explorer
  - Verifies correct prioritization
  - Verifies sitemap completeness
- **Sitemap tests**: Pure unit tests for graph operations, persistence, merging

## Phase 2 Exit Criteria

- [ ] Scout can BFS-explore a multi-page site and build a sitemap
- [ ] Scout detects auth-gated pages and reports them
- [ ] Deep Explorer produces rich page analysis with selector chains
- [ ] Explorer orchestrates Scout → Deep flow correctly
- [ ] Sitemap persists to `.replaybot/sitemap.json` and reloads
- [ ] All tests pass with mock LLM (no real API calls in CI)
