# Replaybot - Architecture & Implementation Plan

## Vision

An MCP server ("Replaybot") that enables AI coding assistants (Claude Code, Copilot, etc.) to explore web apps via Playwright, record actions as structured JSON, and replay them deterministically without LLM — turning LLM-driven exploration into reliable, parameterized e2e tests.

## Architecture

### Multi-Agent System

```
┌─────────────────────────────────────────────────┐
│                  MCP Server                      │
│  Tools: explore, plan_test, execute, replay,     │
│         list_recordings, get_sitemap             │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────┐    ┌───────────┐                  │
│  │ Planner  │◄──►│ Explorer  │                  │
│  │  Agent   │    │  Agent    │                  │
│  └──────────┘    ├───────────┤                  │
│       │          │  ┌──────┐ │                  │
│       │          │  │Scout │ │  BFS, fast/cheap │
│       │          │  │(Haiku)│ │  page discovery  │
│       │          │  └──────┘ │                  │
│       │          │  ┌──────┐ │                  │
│       │          │  │ Deep │ │  Detailed page   │
│       │          │  │Explore│ │  analysis        │
│       │          │  └──────┘ │                  │
│       │          └───────────┘                  │
│       ▼                                          │
│  ┌──────────┐    ┌───────────┐                  │
│  │Execution │───►│  Replay   │                  │
│  │  Agent   │    │  Agent    │                  │
│  └──────────┘    └───────────┘                  │
│                                                  │
│  ┌──────────────────────────────┐               │
│  │     Page State Manager       │               │
│  │  (current page, nav graph,   │               │
│  │   sitemap, page fingerprints)│               │
│  └──────────────────────────────┘               │
└─────────────────────────────────────────────────┘
```

### Agent Roles

#### 1. Explorer Agent (contains Scout + Deep)
- **Scout sub-agent** (uses Haiku/cheap-fast model)
  - BFS traversal of the application
  - Discovers pages, links, forms, interactive elements
  - Builds a sitemap/navigation graph quickly
  - Extracts: page URLs, link targets, form fields, button labels
  - Output: `SiteMap` with nodes (pages) and edges (navigation paths)

- **Deep Explorer sub-agent**
  - Goes deep into specific pages/flows
  - Observes via: accessibility tree + screenshots + simplified DOM
  - Understands page semantics, form purposes, validation rules
  - Records detailed interaction possibilities per page

#### 2. Planner Agent
- Receives a high-level goal (e.g., "test the signup flow")
- Consults the sitemap and page knowledge from Explorer
- Breaks goal into ordered steps with expected outcomes
- Collaborates with Explorer in a loop:
  - Planner proposes next step → Explorer executes → reports page state → Planner adjusts
- Generates assertions (LLM-generated, visual, user-defined)
- Output: `TestPlan` with steps, assertions, and parameters

#### 3. Execution Agent
- Takes natural language test description
- Scans saved exploration data and recorded steps
- Synthesizes an execution plan by matching intent to known actions
- Resolves navigation: knows which page it's on, which page it needs to reach
- Output: `ExecutionLog` (ordered action sequence ready for replay)

#### 4. Replay Agent
- Deterministic — no LLM needed at runtime
- Reads `ExecutionLog` JSON and replays actions via Playwright
- Supports parameterization (variable substitution for test data)
- Runs assertions (element checks, visual regression, custom)
- Reports pass/fail with screenshots on failure

### Page State Manager
All agents share awareness of:
- Current page (URL, title, fingerprint)
- Target page (where they need to go)
- Navigation graph (how to get between pages)
- Page element cache (selectors, accessibility info)

## Key Design Decisions

### Selector Chaining & Fallback
Each action records multiple selector strategies in priority order. During replay, the system tries each in sequence until one matches:
1. **ARIA selector** (most resilient): `role=button[name="Submit"]`
2. **Data-testid**: `[data-testid="submit-btn"]`
3. **CSS selector**: `form.signup button[type="submit"]`
4. **Text content**: `text="Sign Up"`
5. **XPath** (last resort): `//form[@class='signup']//button`

If ALL selectors fail during replay → triggers **self-healing**: LLM examines current page state, finds the equivalent element, updates the recording, and flags the change for human review.

### Authentication Handling
- Scout agent detects login forms and auth-gated pages automatically
- When detected, Scout pauses and asks the AI assistant (via MCP response) to provide credentials or auth context
- Auth flows can themselves be recorded as replayable sequences
- Supports cookie/storage state injection for pre-authenticated sessions

### SPA & Dynamic Content Support
- **DOM fingerprinting**: Hashes key DOM elements to create unique page identifiers beyond URL
- **State-based routing**: Tracks modals, tabs, accordions, drawers as virtual "pages" in the sitemap
- Virtual page transitions recorded as state changes, not just URL changes
- Mutation observer tracks significant DOM changes during exploration

### Self-Healing Replay
When a replay action fails (selector not found, element not interactable):
1. Capture current page state (a11y tree + screenshot + DOM)
2. Invoke LLM to find the equivalent element on the changed page
3. If found with high confidence → update recording, continue replay
4. Flag ALL self-healed actions in the test report for human review
5. If LLM cannot resolve → fail with detailed diff of what changed

### Recordings as Version-Controlled Artifacts
- Stored as human-readable JSON in `.replaybot/` within the project directory
- Designed to be committed to version control alongside app code
- Parameterized values use `{{param}}` template syntax (no secrets in recordings)
- Screenshots stored as separate files referenced by path (can be .gitignored)

## Data Structures

### Action Record (JSON)
```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "type": "click | type | navigate | select | hover | scroll | wait | assert",
  "selectors": [
    { "strategy": "aria", "value": "role=button[name=\"Submit\"]" },
    { "strategy": "testid", "value": "[data-testid=\"submit-btn\"]" },
    { "strategy": "css", "value": "form.signup button[type=\"submit\"]" },
    { "strategy": "text", "value": "text=\"Sign Up\"" }
  ],
  "value": "typed text or selected value (supports {{param}} templates)",
  "page": {
    "url": "current URL",
    "title": "page title",
    "fingerprint": "DOM hash for SPA state identification"
  },
  "screenshot_before": "screenshots/action-uuid-before.png",
  "screenshot_after": "screenshots/action-uuid-after.png",
  "metadata": {
    "confidence": 0.95,
    "reasoning": "LLM's reasoning for this action",
    "self_healed": false,
    "heal_history": []
  }
}
```

### Test Recording (JSON)
```json
{
  "id": "uuid",
  "name": "User signup flow",
  "description": "Tests the complete user registration process",
  "created_at": "ISO-8601",
  "base_url": "https://myapp.com",
  "parameters": {
    "email": { "type": "string", "default": "test@example.com" },
    "password": { "type": "string", "default": "SecurePass123!" }
  },
  "actions": [ /* ActionRecord[] */ ],
  "assertions": [
    {
      "type": "element_visible | text_content | url_match | screenshot | custom",
      "selector": "css or aria selector",
      "expected": "expected value or screenshot path",
      "after_action_id": "uuid of action after which to assert"
    }
  ],
  "sitemap_snapshot": { /* relevant portion of nav graph */ }
}
```

### Site Map
```json
{
  "pages": [
    {
      "url": "/signup",
      "title": "Sign Up",
      "elements": ["form#signup", "input[name=email]", "button[type=submit]"],
      "links_to": ["/login", "/home"],
      "discovered_at": "ISO-8601"
    }
  ],
  "edges": [
    { "from": "/home", "to": "/signup", "via": "click", "selector": "a[href='/signup']" }
  ]
}
```

## MCP Tools Exposed

| Tool | Description |
|------|-------------|
| `scout_app` | BFS exploration of app, builds sitemap (fast/cheap model) |
| `explore_page` | Deep exploration of a specific page or flow |
| `plan_test` | Create a test plan from natural language goal |
| `execute_exploration` | Run the collaborative Planner↔Explorer loop |
| `create_replay` | Convert exploration results into a replayable execution log |
| `replay_test` | Deterministically replay a recorded test with optional params |
| `list_recordings` | List all saved test recordings |
| `get_sitemap` | Return the discovered navigation graph |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser automation**: Playwright
- **MCP**: `@modelcontextprotocol/sdk`
- **LLM**: Provider-agnostic interface (adapters for Claude, OpenAI, etc.)
  - Scout uses cheap/fast model (Haiku-class)
  - Deep Explorer + Planner use capable model (Sonnet/Opus-class)
- **Page observation**: Accessibility tree + screenshots + simplified DOM
- **Storage**: Local JSON files in `.replaybot/` directory
- **Visual regression**: `pixelmatch` for screenshot comparison

## Project Structure

```
replaybot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── server.ts                # MCP tool definitions
│   ├── agents/
│   │   ├── types.ts             # Shared agent interfaces
│   │   ├── scout.ts             # Scout sub-agent (BFS, cheap model)
│   │   ├── deep-explorer.ts     # Deep exploration sub-agent
│   │   ├── explorer.ts          # Explorer agent (orchestrates scout + deep)
│   │   ├── planner.ts           # Planner agent (test plan generation)
│   │   ├── execution.ts         # Execution agent (NL → action sequence)
│   │   └── replay.ts            # Replay agent (deterministic playback)
│   ├── browser/
│   │   ├── controller.ts        # Playwright browser lifecycle
│   │   ├── observer.ts          # Page state observation (a11y, DOM, screenshots)
│   │   └── actions.ts           # Action execution primitives
│   ├── llm/
│   │   ├── interface.ts         # Provider-agnostic LLM interface
│   │   ├── claude-adapter.ts    # Claude/Anthropic adapter
│   │   ├── openai-adapter.ts    # OpenAI adapter
│   │   └── prompts.ts           # Agent system prompts
│   ├── state/
│   │   ├── page-state.ts        # Page state manager
│   │   ├── sitemap.ts           # Navigation graph
│   │   └── recordings.ts        # Recording storage/retrieval
│   └── assertions/
│       ├── element.ts           # Element-based assertions
│       ├── visual.ts            # Visual regression (pixelmatch)
│       └── custom.ts            # User-defined assertion support
├── tests/
│   ├── agents/
│   ├── browser/
│   └── integration/
└── .replaybot/             # Runtime data directory
    ├── recordings/
    ├── sitemap.json
    └── screenshots/
```

## Implementation Order

### Phase 1: Foundation
1. Project setup (package.json, tsconfig, dependencies)
2. Browser controller + observer (Playwright lifecycle, page state extraction)
3. LLM interface + Claude adapter
4. Page state manager + sitemap data structures
5. Action execution primitives

### Phase 2: Scout & Explorer
6. Scout agent (BFS page discovery with cheap model)
7. Deep explorer agent (detailed page analysis)
8. Explorer orchestrator (scout + deep coordination)
9. Sitemap persistence

### Phase 3: Planner & Recording
10. Planner agent (goal → test plan)
11. Collaborative Planner↔Explorer loop
12. Action recording to JSON
13. Assertion generation (LLM, visual, user-defined)

### Phase 4: Execution & Replay
14. Execution agent (NL → action sequence from saved data)
15. Replay agent (deterministic playback)
16. Parameterization support
17. Test result reporting

### Phase 5: MCP Integration
18. MCP server setup
19. Tool definitions and handlers
20. End-to-end integration tests
