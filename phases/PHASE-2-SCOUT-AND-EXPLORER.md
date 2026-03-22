# Phase 2: Scout & Explorer

> Status: APPROVED — decisions locked in
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
  llm: LLMClient;
  pageState: PageStateManager;
  sitemap: SiteMapManager;
  config: ReplaybotConfig;
}
```

**Decisions**:
- **Direct method calls** for agent communication — no message bus. Scout/Deep Explorer are called directly by the orchestrator. Simple, debuggable, no over-engineering.
- **Cancellable via AbortSignal** — agents accept `AbortSignal` and check it between operations. Caller can abort at any time.
- **Retry once, then surface error** — agents retry a failed action once. If it fails again, they log the error and skip that item (don't block the whole exploration).
- **Budget per invocation** — `maxTokens` and `maxTimeMs` on every agent call. Defaults: Scout 50k tokens/5min, Deep Explorer 100k tokens/10min per page.

---

### 2.2 Scout Agent (`src/agents/scout.ts`)

Fast, breadth-first page discovery using a cheap/fast model (Haiku-class).

```typescript
interface ScoutAgent extends Agent {
  scoutApp(entryUrl: string, options?: ScoutOptions): Promise<SiteMap>;
  scoutPage(url: string): Promise<ScoutPageResult>;
  expandFrontier(): Promise<ScoutPageResult[]>;
}

interface ScoutOptions {
  maxPages: number;            // Default: 50
  maxDepth: number;            // Default: 5
  stayWithinDomain: boolean;   // Default: true
  excludePatterns: string[];
  includePatterns: string[];
  timeout: number;             // Default: 300000 (5min)
  signal?: AbortSignal;
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
  pageType: string;
  description: string;
  screenshotPath: string;
}
```

**Decisions**:
- **Links only for v1** — Scout follows `<a>` links only, no button clicks or dropdown interactions. Keeps it fast and predictable.
- **Skip infinite scroll** — don't try to trigger lazy loading. Deep Explorer handles dynamic content later.
- **Fingerprint dedup** — compare page fingerprints to skip duplicate pages with different URLs (common in SPAs with query params). If fingerprint matches a known page, skip it.
- **500ms delay between visits** — polite crawling, configurable via options.
- **No network sniffing** — skip API endpoint detection for v1.

---

### 2.3 Deep Explorer Agent (`src/agents/deep-explorer.ts`)

Thorough analysis of a specific page or flow using a capable model.

```typescript
interface DeepExplorerAgent extends Agent {
  explorePage(url: string): Promise<DeepPageAnalysis>;
  exploreFlow(startUrl: string, flowDescription: string): Promise<FlowAnalysis>;
  exploreElement(selector: SelectorChain): Promise<ElementAnalysis>;
}
```

**Decisions**:
- **Option C: Observe first, selectively verify** — Deep Explorer observes the page and predicts outcomes. For high-confidence predictions (e.g., "this link navigates to /about"), no verification. For low-confidence or complex interactions (e.g., "form submission triggers X"), it verifies by actually performing the action.
- **Generate selectors at analysis time** — Deep Explorer produces `SelectorChain` for every element it analyzes, so downstream agents have ready-to-use selectors.
- **Skip precondition-dependent pages** — if a page requires specific state (items in cart, etc.), Deep Explorer notes the precondition but doesn't attempt to set it up. That's the Planner's job in Phase 3.
- **No performance observations** — skip timing/animation analysis for v1.

---

### 2.4 Explorer Orchestrator (`src/agents/explorer.ts`)

Coordinates Scout and Deep Explorer.

```typescript
interface ExplorerAgent extends Agent {
  explore(entryUrl: string, options?: ExploreOptions): Promise<ExplorationResult>;
  exploreArea(urls: string[], depth: 'scout' | 'deep'): Promise<ExplorationResult>;
  getSiteMap(): SiteMap;
  getPageAnalysis(url: string): DeepPageAnalysis | null;
}

interface ExploreOptions extends ScoutOptions {
  deepExplorePages: 'all' | 'forms_only' | 'interactive_only' | 'none';
  deepExploreLimit: number;    // Default: 10
  prioritize: 'forms' | 'navigation' | 'breadth';
  signal?: AbortSignal;
}
```

**Decisions**:
- **Resumable** — exploration state (frontier, visited set, partial sitemap) persisted to disk. `explore()` checks for existing state and resumes.
- **Auth gates: pause and return** — when Scout hits an auth-gated page, the orchestrator pauses exploration of that branch and includes `auth_required` in the result. The caller (MCP layer in Phase 5) can provide credentials and resume.
- **Sequential, not concurrent** — Scout completes first, then Deep Explorer runs on prioritized pages. No parallel execution for v1 (simpler, avoids browser context conflicts).

---

### 2.5 Sitemap Persistence (`src/state/sitemap.ts`)

Store and retrieve the navigation graph.

```typescript
interface SiteMapManager {
  getSiteMap(): SiteMap;
  addPage(page: SiteMapPage): void;
  addEdge(edge: SiteMapEdge): void;
  updatePage(url: string, updates: Partial<SiteMapPage>): void;

  getPage(url: string): SiteMapPage | null;
  findPath(from: string, to: string): SiteMapEdge[];
  getUnvisitedPages(): string[];
  getAuthGatedPages(): SiteMapPage[];

  save(path?: string): Promise<void>;
  load(path?: string): Promise<void>;
  merge(other: SiteMap): void;

  addVirtualPage(parentUrl: string, virtualPage: VirtualPage): void;
  getVirtualPages(url: string): VirtualPage[];
}
```

**Decisions**:
- **Auto-save on every mutation** — same pattern as PageStateManager (fire-and-forget persist).
- **Deep analysis stored alongside sitemap** — `SiteMapPage` includes an optional `deepAnalysis` field. Single source of truth.
- **Merge: union with newer-wins** — when merging two sitemaps, take the union of all pages/edges. If both have analysis for the same page, keep the one with the more recent `lastVisited` timestamp.

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
