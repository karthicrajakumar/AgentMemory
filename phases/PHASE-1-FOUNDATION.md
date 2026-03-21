# Phase 1: Foundation

> Status: DRAFT — pending discussion

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

**Open questions**:
- Should we use a monorepo (e.g., separate `@replaybot/core`, `@replaybot/mcp`) or keep it as a single package?
- Node.js minimum version — 18? 20?
- ESM-only or dual CJS/ESM?

---

### 1.2 Browser Controller (`src/browser/controller.ts`)

Manages Playwright browser/context/page lifecycle.

```typescript
interface BrowserController {
  // Lifecycle
  launch(options?: LaunchOptions): Promise<void>;
  close(): Promise<void>;

  // Page management
  currentPage(): Page;
  navigateTo(url: string): Promise<void>;
  waitForNavigation(): Promise<void>;

  // Context management (for auth state)
  saveStorageState(path: string): Promise<void>;
  loadStorageState(path: string): Promise<void>;

  // Configuration
  setViewport(width: number, height: number): Promise<void>;
  setBrowserType(type: 'chromium' | 'firefox' | 'webkit'): void;
}
```

**Key decisions to discuss**:
- Should we support multiple simultaneous pages/tabs?
- Should the controller manage browser pool for parallel exploration?
- Headless by default, headed for debugging? Or configurable?

---

### 1.3 Page Observer (`src/browser/observer.ts`)

Extracts page state for LLM consumption. This is the "eyes" of every agent.

```typescript
interface PageObserver {
  // Core observations
  getAccessibilityTree(page: Page): Promise<AccessibilityNode[]>;
  getSimplifiedDOM(page: Page): Promise<string>;
  takeScreenshot(page: Page): Promise<Buffer>;

  // Page identity
  getPageFingerprint(page: Page): Promise<string>;
  getPageMetadata(page: Page): Promise<PageMeta>;

  // Element discovery
  getInteractiveElements(page: Page): Promise<InteractiveElement[]>;
  getFormFields(page: Page): Promise<FormField[]>;
  getLinks(page: Page): Promise<LinkElement[]>;

  // Combined observation for LLM context
  observe(page: Page): Promise<PageObservation>;
}

interface PageObservation {
  url: string;
  title: string;
  fingerprint: string;
  accessibilityTree: AccessibilityNode[];
  simplifiedDOM: string;
  screenshot: Buffer;
  interactiveElements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
}
```

**Key decisions to discuss**:
- How aggressively should we simplify the DOM? Strip all styling? Only keep semantic elements?
- Should the accessibility tree be flattened or preserve hierarchy?
- Screenshot format — full page or viewport only? What resolution?
- Should we include computed styles for any elements (e.g., visibility, color)?
- DOM fingerprinting algorithm — hash the tag structure? Include text content?

---

### 1.4 LLM Interface (`src/llm/interface.ts`)

Provider-agnostic interface for LLM calls. Adapters implement this for each provider.

```typescript
interface LLMProvider {
  name: string;

  // Core completion
  complete(request: LLMRequest): Promise<LLMResponse>;

  // Capabilities
  supportsVision(): boolean;
  supportsTool_use(): boolean;
  maxContextTokens(): number;
}

interface LLMRequest {
  systemPrompt: string;
  messages: LLMMessage[];
  images?: Buffer[];           // Screenshots for vision models
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];    // For structured output
  modelTier: 'fast' | 'capable';  // Scout uses 'fast', others use 'capable'
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

// Configuration
interface LLMConfig {
  provider: 'anthropic' | 'openai' | string;
  fastModel: string;      // e.g., 'claude-haiku-4-5-20251001'
  capableModel: string;   // e.g., 'claude-sonnet-4-6'
  apiKey: string;
}
```

**Key decisions to discuss**:
- Should we support streaming for real-time exploration feedback?
- How to handle rate limiting and retries?
- Should the interface support tool use / structured output natively?
- Cost tracking — should we track token usage per agent per session?
- Should `modelTier` be more granular (e.g., 'cheap', 'balanced', 'premium')?

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

  // Knowledge base
  addPageKnowledge(url: string, knowledge: PageKnowledge): void;
  getPageKnowledge(url: string): PageKnowledge | null;

  // Fingerprinting (SPA support)
  registerFingerprint(fingerprint: string, virtualPage: VirtualPage): void;
  lookupFingerprint(fingerprint: string): VirtualPage | null;
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

**Key decisions to discuss**:
- In-memory only, or persist to disk between sessions?
- Should page knowledge expire/refresh after a configurable TTL?
- How to handle conflicting knowledge (e.g., page changed between visits)?

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

  // Waiting
  waitForElement(selectors: SelectorChain, timeout?: number): Promise<ActionResult>;
  waitForNavigation(timeout?: number): Promise<ActionResult>;
}

interface SelectorChain {
  selectors: Array<{
    strategy: 'aria' | 'testid' | 'css' | 'text' | 'xpath';
    value: string;
  }>;
}

interface ActionResult {
  success: boolean;
  usedSelector: { strategy: string; value: string };  // Which selector worked
  error?: string;
  duration: number;  // ms
}
```

**Key decisions to discuss**:
- Should actions auto-wait for elements (Playwright's auto-waiting) or explicit waits?
- Timeout defaults — how long to wait for each selector before trying the next?
- Should we record timing between actions for realistic replay speed?
- How to handle iframes and shadow DOM?

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
