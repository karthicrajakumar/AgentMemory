# Phase 5: MCP Integration

> Status: DRAFT — pending discussion
> Depends on: Phase 4 (Execution & Replay)

## Goal

Wire everything together as an MCP server that AI coding assistants can use as a tool. Define the tool interfaces, handle lifecycle, and build end-to-end integration tests. This is the phase where Replaybot becomes usable.

## Deliverables

### 5.1 MCP Server Setup (`src/index.ts`, `src/server.ts`)

```typescript
// src/index.ts — entry point
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReplaybotServer } from './server.js';

const server = new ReplaybotServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Server lifecycle**:
- Browser instance managed lazily (launched on first tool call that needs it)
- Browser kept alive across tool calls within a session
- Graceful shutdown: close browser, save state on exit
- Configurable via environment variables or MCP config

**Configuration** (via env vars or `replaybot.config.json`):
```json
{
  "llm": {
    "provider": "anthropic",
    "fastModel": "claude-haiku-4-5-20251001",
    "capableModel": "claude-sonnet-4-6",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "browser": {
    "type": "chromium",
    "headless": true,
    "viewport": { "width": 1280, "height": 720 }
  },
  "storage": {
    "dir": ".replaybot",
    "screenshotsEnabled": true,
    "maxRecordings": 100
  },
  "replay": {
    "selfHealEnabled": true,
    "defaultTimeout": 30000,
    "retryCount": 1
  }
}
```

---

### 5.2 MCP Tool Definitions

Each tool is designed for how an AI assistant would naturally use it.

#### `scout_app` — Discover application structure
```typescript
{
  name: "scout_app",
  description: "Quickly explore a web application using breadth-first search to discover pages, forms, and navigation structure. Uses a fast/cheap model. Returns a sitemap.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Entry URL to start exploring from"
      },
      max_pages: {
        type: "number",
        description: "Maximum pages to discover (default: 50)"
      },
      max_depth: {
        type: "number",
        description: "Maximum click depth from entry page (default: 5)"
      },
      exclude_patterns: {
        type: "array",
        items: { type: "string" },
        description: "URL patterns to skip (e.g., '/admin/*', '/api/*')"
      },
      stay_within_domain: {
        type: "boolean",
        description: "Only explore pages on the same domain (default: true)"
      }
    },
    required: ["url"]
  }
}
```

**Returns**: Sitemap summary — pages found, forms detected, auth gates identified, navigation graph.

---

#### `explore_page` — Deep analysis of a specific page
```typescript
{
  name: "explore_page",
  description: "Perform deep analysis of a specific page — identifies forms, interactive elements, validation rules, and suggests test scenarios. Uses a capable model with screenshots + accessibility tree.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page URL to analyze" },
      focus: {
        type: "string",
        description: "Optional area to focus on (e.g., 'the signup form', 'the navigation menu')"
      }
    },
    required: ["url"]
  }
}
```

**Returns**: Page analysis — forms with fields, interactive elements with predicted outcomes, suggested test scenarios.

---

#### `plan_test` — Create a test plan from natural language
```typescript
{
  name: "plan_test",
  description: "Create a structured test plan from a natural language description. Uses the sitemap and page knowledge to plan steps, assertions, and parameterizable values.",
  inputSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "What to test (e.g., 'Test user signup with valid and invalid inputs')"
      },
      base_url: {
        type: "string",
        description: "Application base URL (uses sitemap's base if available)"
      },
      include_negative_cases: {
        type: "boolean",
        description: "Also plan negative/edge case tests (default: false)"
      }
    },
    required: ["goal"]
  }
}
```

**Returns**: Test plan with steps, assertions, and parameters. Asks for confirmation before executing.

---

#### `execute_exploration` — Run the collaborative Planner↔Explorer loop
```typescript
{
  name: "execute_exploration",
  description: "Execute a test plan by driving the browser step-by-step. The Planner and Explorer agents collaborate — the Planner directs, the Explorer acts, and all actions are recorded.",
  inputSchema: {
    type: "object",
    properties: {
      plan_id: {
        type: "string",
        description: "ID of a previously created test plan (from plan_test)"
      },
      goal: {
        type: "string",
        description: "Or provide a goal directly — a plan will be created and executed"
      },
      parameters: {
        type: "object",
        description: "Parameter values to use (e.g., {\"email\": \"test@example.com\"})"
      },
      save_recording: {
        type: "boolean",
        description: "Save the recorded actions for replay (default: true)"
      }
    }
  }
}
```

**Returns**: Execution result — actions taken, assertions checked, recording ID if saved.

---

#### `replay_test` — Replay a recorded test
```typescript
{
  name: "replay_test",
  description: "Replay a previously recorded test deterministically without LLM. Supports parameter overrides for data-driven testing. Self-heals broken selectors if enabled.",
  inputSchema: {
    type: "object",
    properties: {
      recording_id: {
        type: "string",
        description: "ID of the recording to replay"
      },
      parameters: {
        type: "object",
        description: "Override parameter values for this run"
      },
      headed: {
        type: "boolean",
        description: "Show browser window during replay (default: false)"
      },
      self_heal: {
        type: "boolean",
        description: "Use LLM to fix broken selectors (default: true)"
      },
      slow_motion: {
        type: "number",
        description: "Delay in ms between actions for debugging (default: 0)"
      }
    },
    required: ["recording_id"]
  }
}
```

**Returns**: Test result — pass/fail, action details, assertion results, self-healing report, screenshot paths.

---

#### `create_replay` — Generate execution plan from NL + saved data
```typescript
{
  name: "create_replay",
  description: "Create a new replayable test by combining existing recordings and exploration data. Describe what you want to test in natural language.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Natural language description of the test (e.g., 'Login then add the first product to cart')"
      },
      parameters: {
        type: "object",
        description: "Parameter values to bake into the test"
      },
      source_recordings: {
        type: "array",
        items: { type: "string" },
        description: "Recording IDs to draw from (auto-detected if omitted)"
      }
    },
    required: ["description"]
  }
}
```

**Returns**: New recording ID and preview of the action sequence.

---

#### `list_recordings` — List saved test recordings
```typescript
{
  name: "list_recordings",
  description: "List all saved test recordings with their names, descriptions, and parameter definitions.",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Filter recordings by name or description (substring match)"
      }
    }
  }
}
```

---

#### `get_sitemap` — View discovered app structure
```typescript
{
  name: "get_sitemap",
  description: "Return the discovered navigation graph of the application — pages, links between them, forms, and auth gates.",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["summary", "detailed", "graph"],
        description: "Output format (default: summary)"
      }
    }
  }
}
```

---

#### `provide_credentials` — Supply auth credentials
```typescript
{
  name: "provide_credentials",
  description: "Provide authentication credentials when an agent reports an auth-gated page. Can supply username/password or a saved browser storage state.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      password: { type: "string" },
      storage_state_path: {
        type: "string",
        description: "Path to Playwright storage state JSON (alternative to username/password)"
      },
      save_auth_flow: {
        type: "boolean",
        description: "Record the login as a reusable authentication recording (default: true)"
      }
    }
  }
}
```

---

### 5.3 MCP Resources (optional)

Expose recordings and sitemap as MCP resources for browsing.

```typescript
// Resource: list of recordings
{
  uri: "replaybot://recordings",
  name: "Test Recordings",
  description: "All saved Replaybot test recordings"
}

// Resource: specific recording
{
  uri: "replaybot://recordings/{id}",
  name: "Recording: {name}",
  description: "Detailed view of a test recording"
}

// Resource: sitemap
{
  uri: "replaybot://sitemap",
  name: "Application Sitemap",
  description: "Discovered navigation graph"
}
```

**Key decisions to discuss**:
- Should we implement MCP resources, or are tools sufficient?
- Should we implement MCP prompts (e.g., pre-built prompt for "explore and test this app")?

---

### 5.4 Client Configuration

How users would add Replaybot to their AI assistant:

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "replaybot": {
      "command": "npx",
      "args": ["replaybot"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-...",
        "REPLAYBOT_STORAGE_DIR": ".replaybot"
      }
    }
  }
}
```

**VS Code / Copilot** (MCP configuration):
```json
{
  "mcp": {
    "servers": {
      "replaybot": {
        "command": "npx",
        "args": ["replaybot"],
        "env": {
          "OPENAI_API_KEY": "sk-..."
        }
      }
    }
  }
}
```

---

### 5.5 End-to-End Integration Tests

Test the full MCP flow: tool call → agent execution → result.

```typescript
// Test fixtures
// 1. A local test web app (Express/Koa) with:
//    - Home page with navigation
//    - Login page (auth gate)
//    - Signup form with validation
//    - Dashboard (auth-gated)
//    - Product listing + detail pages
//    - Shopping cart flow

// Test scenarios
describe('Replaybot E2E', () => {
  it('scouts a multi-page app and builds sitemap');
  it('deep explores a signup form and identifies fields');
  it('plans a signup test from natural language');
  it('executes exploration and records actions');
  it('replays a recording deterministically');
  it('self-heals when a selector breaks');
  it('parameterizes a recording and replays with different data');
  it('detects auth gate and handles credentials');
  it('creates a replay from NL combining multiple recordings');
  it('generates JUnit XML report for CI');
});
```

**Key decisions to discuss**:
- Should integration tests use real LLM calls or mocks?
  - Real: Tests actual behavior, but slow + costly
  - Mocks: Fast + free, but may not catch prompt issues
  - Hybrid: Mock in CI, real for a separate "smoke test" suite?
- Should we build the test web app or use a public test site (e.g., demo.playwright.dev)?
- How to test MCP protocol correctness? Use the MCP inspector tool?

---

### 5.6 NPM Package & Distribution

```json
{
  "name": "replaybot",
  "version": "0.1.0",
  "bin": {
    "replaybot": "./dist/index.js"
  },
  "files": ["dist/"],
  "engines": {
    "node": ">=18"
  }
}
```

Users install and use via:
```bash
npm install -g replaybot
# or
npx replaybot
```

**Key decisions to discuss**:
- Should Playwright browsers be auto-installed on first run?
- Should we bundle Playwright or require it as a peer dependency?
- License: MIT? Apache 2.0?

---

## Usage Example (Full Session)

Here's how a user would interact with Replaybot through Claude Code:

```
User: "I want to write e2e tests for my app at http://localhost:3000"

Claude Code: [calls scout_app with url="http://localhost:3000"]
→ "I found 12 pages including a login form, signup form, product listing,
   and checkout flow. 3 pages are behind authentication."

User: "Test the signup flow"

Claude Code: [calls plan_test with goal="Test the signup flow"]
→ "Here's the test plan:
   1. Navigate to /signup
   2. Fill in name, email, password
   3. Submit form
   4. Verify redirect to /welcome
   5. Verify welcome message shows user's name
   Parameters: {{name}}, {{email}}, {{password}}"

User: "Looks good, run it"

Claude Code: [calls execute_exploration with goal="Test the signup flow"]
→ "Recorded 8 actions. All assertions passed.
   Recording saved as 'signup-flow-abc123'"

User: "Now replay it with a different email"

Claude Code: [calls replay_test with recording_id="abc123",
              parameters={email: "other@example.com"}]
→ "✓ All 8 actions replayed successfully. 5/5 assertions passed."

User: "Make it run in CI"

Claude Code: [calls replay_test with recording_id="abc123", headed=false]
→ exports JUnit XML to .replaybot/results/
```

---

## Phase 5 Exit Criteria

- [ ] MCP server starts and accepts connections
- [ ] All 8 tools are callable and return structured results
- [ ] Full flow works: scout → explore → plan → execute → record → replay
- [ ] Self-healing works through MCP tool interface
- [ ] Auth credential flow works (agent detects → asks → user provides → continues)
- [ ] Recordings persist and replay across sessions
- [ ] `npx replaybot` launches the server
- [ ] Integration tests cover the core user journey
- [ ] Configuration via env vars and config file works
