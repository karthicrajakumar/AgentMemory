# Phase 1: Foundation

> Status: APPROVED — decisions locked in

## Goal

Set up the project skeleton and build the core primitives that every agent depends on: browser control, page observation, LLM communication, page state tracking, and action execution.

## Deliverables

### 1.1 Project Setup

**Files**: `package.json`, `tsconfig.json`, `.gitignore`, `.eslintrc`

**Dependencies**:
| Package | Purpose |
|---------|---------|
| `playwright` | Browser automation |
| `@modelcontextprotocol/sdk` | MCP server (used in Phase 5, but declared now) |
| `uuid` | Action/recording IDs |
| `pixelmatch` + `pngjs` | Visual regression (used in later phases) |
| `zod` | Schema validation for recordings, configs |

**Dev dependencies**: `typescript`, `vitest`, `eslint`, `prettier`

**Decisions**:
- **Single package** — no monorepo. Split later if needed.
- **Node 20+** minimum — current LTS, native fetch, better perf.
- **ESM-only** — `"type": "module"` in package.json, no CJS build.

---

### 1.2 Browser Controller (`src/browser/controller.ts`)

Manages Playwright browser/context/page lifecycle.

```typescript
interface BrowserController {
  // Lifecycle
  launch(options?: LaunchOptions): Promise<void>;
  close(): Promise<void>;

  // Page management (multi-page support)
  currentPage(): Page;
  pages(): Page[];
  createPage(): Promise<Page>;
  switchToPage(index: number): void;
  onNewPage(handler: (page: Page) => void): void;
  navigateTo(url: string): Promise<void>;
  waitForNavigation(): Promise<void>;

  // Browser pool for parallel exploration
  acquireContext(): Promise<BrowserContext>;
  releaseContext(context: BrowserContext): Promise<void>;
  poolSize(): number;
  setPoolSize(size: number): void;

  // Context management (for auth state)
  saveStorageState(path: string): Promise<void>;
  loadStorageState(path: string): Promise<void>;

  // Configuration
  setViewport(width: number, height: number): Promise<void>;
  setBrowserType(type: 'chromium' | 'firefox' | 'webkit'): void;
}

interface LaunchOptions {
  headless?: boolean;      // Default: false (headed)
  browserType?: 'chromium' | 'firefox' | 'webkit';
  poolSize?: number;       // Default: 1
  viewport?: { width: number; height: number };
  storageStatePath?: string;
}
```

**Decisions**:
- **Multi-page support** — track multiple tabs. Needed for OAuth popups, payment redirects, etc.
- **Browser pool from the start** — manage N browser contexts for parallel exploration.
- **Headed by default** — users see the browser. Pass `headless: true` for CI/silent mode.

---

### 1.3 Page Observer (`src/browser/observer.ts`)

Extracts page state for LLM consumption. This is the "eyes" of every agent.

```typescript
interface PageObserver {
  // Core observations
  getAccessibilityTree(page: Page): Promise<AccessibilityNode>;  // Hierarchical tree
  getSimplifiedDOM(page: Page): Promise<string>;                  // Semantic-only
  takeScreenshot(page: Page, options?: ScreenshotOptions): Promise<Buffer>;

  // Page identity
  getPageFingerprint(page: Page): Promise<string>;  // Tag structure hash
  getPageMetadata(page: Page): Promise<PageMeta>;

  // Element discovery
  getInteractiveElements(page: Page): Promise<InteractiveElement[]>;
  getFormFields(page: Page): Promise<FormField[]>;
  getLinks(page: Page): Promise<LinkElement[]>;

  // Combined observation for LLM context
  observe(page: Page): Promise<PageObservation>;
}

interface ScreenshotOptions {
  fullPage?: boolean;  // Default: false (viewport only)
}

interface AccessibilityNode {
  role: string;
  name: string;
  children: AccessibilityNode[];
  properties?: Record<string, string>;
}

interface PageObservation {
  url: string;
  title: string;
  fingerprint: string;
  accessibilityTree: AccessibilityNode;
  simplifiedDOM: string;
  screenshot: Buffer;
  interactiveElements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
}
```

**Decisions**:
- **Semantic-only DOM** — strip scripts, styles, SVGs, hidden elements. Keep headings, forms, links, buttons, landmarks.
- **Preserve accessibility tree hierarchy** — tree structure matching DOM nesting with `children` arrays.
- **Viewport screenshots by default** (1280x720), full page on demand via `fullPage: true`.
- **No computed styles** — not included in observations.
- **Tag structure hash** for fingerprinting — hash tag names + hierarchy, ignore text content. Fast and stable.

---

### 1.4 LLM Interface (`src/llm/interface.ts`)

Provider-agnostic interface for LLM calls. Adapters implement this for each provider.

```typescript
interface LLMProvider {
  name: string;

  // Core completion
  complete(request: LLMRequest): Promise<LLMResponse>;

  // Streaming
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;

  // Capabilities
  supportsVision(): boolean;
  supportsToolUse(): boolean;
  maxContextTokens(): number;
}

interface LLMRequest {
  systemPrompt: string;
  messages: LLMMessage[];
  images?: Buffer[];           // Screenshots for vision models
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];    // For structured output
  modelTier: 'fast' | 'balanced' | 'premium';
  agentId?: string;            // For cost tracking attribution
}

interface LLMStreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

// Configuration
interface LLMConfig {
  provider: 'anthropic' | 'openai' | string;
  fastModel: string;       // e.g., 'claude-haiku-4-5-20251001'
  balancedModel: string;   // e.g., 'claude-sonnet-4-6'
  premiumModel: string;    // e.g., 'claude-opus-4-6'
  apiKey: string;
  rateLimits?: {
    maxRequestsPerMinute: number;
    maxTokensPerMinute: number;
  };
}

// Cost tracking
interface UsageTracker {
  record(agentId: string, usage: { inputTokens: number; outputTokens: number; model: string }): void;
  getAgentUsage(agentId: string): AgentUsage;
  getSessionUsage(): SessionUsage;
  reset(): void;
}

interface AgentUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  requestCount: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}
```

**Decisions**:
- **Streaming from the start** — `stream()` method returns `AsyncIterable<LLMStreamChunk>` for real-time feedback.
- **Token bucket + exponential backoff** — client-side rate limiter (configurable requests/min and tokens/min) plus retry on 429/5xx.
- **Per-agent cost tracking** — `UsageTracker` records tokens by agent ID and model. Reports cost breakdown.
- **Three model tiers** — `fast` (Haiku), `balanced` (Sonnet), `premium` (Opus). Agents declare which tier they need.

---

### 1.5 Page State Manager (`src/state/page-state.ts`)

Shared state that all agents read/write. Tracks where we are, where we've been, and what we know.

```typescript
interface PageStateManager {
  // Current state
  getCurrentPage(): PageState;
  setCurrentPage(state: PageState): void;

  // Navigation awareness
  setTargetPage(url: string): void;
  getTargetPage(): string | null;
  getPathTo(targetUrl: string): NavigationStep[];

  // Knowledge base (last-write-wins)
  addPageKnowledge(url: string, knowledge: PageKnowledge): void;
  getPageKnowledge(url: string): PageKnowledge | null;
  getAllKnowledge(): Map<string, PageKnowledge>;

  // Fingerprinting (SPA support)
  registerFingerprint(fingerprint: string, virtualPage: VirtualPage): void;
  lookupFingerprint(fingerprint: string): VirtualPage | null;

  // Persistence
  save(path?: string): Promise<void>;
  load(path?: string): Promise<void>;
}

interface PageState {
  url: string;
  title: string;
  fingerprint: string;
  virtualPageId?: string;  // For SPA states within same URL
}

interface PageKnowledge {
  elements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
  authGated: boolean;
  lastVisited: string;
  notes: string;  // LLM-generated description of page purpose
}
```

**Decisions**:
- **Persist to disk** — save to `.replaybot/state.json` on every write. Resume across sessions.
- **No TTL** — knowledge persists until explicitly re-explored by an agent.
- **Last write wins** — newer observations replace older. No version history for v1.

---

### 1.6 Action Executor (`src/browser/actions.ts`)

Low-level action primitives that translate action records into Playwright calls.

```typescript
interface ActionExecutor {
  // Core actions
  click(selectors: SelectorChain): Promise<ActionResult>;
  type(selectors: SelectorChain, text: string): Promise<ActionResult>;
  select(selectors: SelectorChain, value: string): Promise<ActionResult>;
  hover(selectors: SelectorChain): Promise<ActionResult>;
  scroll(direction: 'up' | 'down', amount?: number): Promise<ActionResult>;
  navigate(url: string): Promise<ActionResult>;

  // Selector resolution with chaining/fallback
  resolveSelector(selectors: SelectorChain): Promise<ResolvedSelector>;

  // Waiting (Playwright auto-wait handles most cases)
  waitForElement(selectors: SelectorChain, timeout?: number): Promise<ActionResult>;
  waitForNavigation(timeout?: number): Promise<ActionResult>;
}

interface SelectorChain {
  selectors: Array<{
    strategy: 'aria' | 'testid' | 'css' | 'text' | 'xpath';
    value: string;
    timeout?: number;  // Default: 5000ms per selector
  }>;
  totalTimeout?: number;   // Default: 15000ms for entire chain
}

interface ActionResult {
  success: boolean;
  usedSelector: { strategy: string; value: string };  // Which selector worked
  error?: string;
  duration: number;    // ms — recorded for replay timing
  timestamp: number;   // When action was executed
}
```

**Decisions**:
- **Playwright auto-wait** — rely on Playwright's built-in auto-waiting (visible, stable, enabled).
- **5s per selector, 15s total** — try each selector in chain for up to 5s, fail the entire chain after 15s.
- **Skip iframes/shadow DOM for v1** — handle in a later phase.
- **Record timing** — `duration` and `timestamp` on every `ActionResult` for realistic replay speed.

---

## Testing Strategy (Phase 1)

- Unit tests for each module using Vitest
- Browser controller/observer tests against a local test HTML page (no network)
- LLM interface tests with mock provider (no real API calls)
- Page state manager tests are pure unit tests

## Phase 1 Exit Criteria

- [ ] `npm install && npm run build` succeeds
- [ ] Can launch browser, navigate to URL, observe page state
- [ ] Can execute click/type/navigate actions with selector chaining
- [ ] LLM interface can complete a request (with mock provider)
- [ ] Page state manager tracks current page and knowledge
- [ ] All unit tests pass
- [ ] Foundation is sufficient for Phase 2 agents to build on
