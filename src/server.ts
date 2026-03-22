#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BrowserController } from './browser/controller.js';
import { PageObserver } from './browser/observer.js';
import { ActionExecutor } from './browser/actions.js';
import { LLMClient, UsageTracker, type LLMProvider, type LLMConfig } from './llm/interface.js';
import { PageStateManager } from './state/page-state.js';
import { SiteMapManager } from './state/sitemap.js';
import { ScoutAgent } from './agents/scout.js';
import { DeepExplorerAgent } from './agents/deep-explorer.js';
import { Orchestrator } from './agents/orchestrator.js';
import { PlannerAgent } from './agents/planner.js';
import { ExecutionAgent } from './agents/execution.js';
import { ReplayAgent } from './agents/replay.js';
import { RecordingManager } from './state/recordings.js';
import { ReportGenerator } from './reporting/generator.js';
import type { AgentContext, Credentials } from './agents/types.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { execSync } from 'child_process';

// ── Configuration ──────────────────────────────────────────────

interface ReplaybotConfig {
  llm: {
    provider: string;
    fastModel: string;
    balancedModel: string;
    premiumModel: string;
    apiKey: string;
  };
  browser: {
    type: 'chromium' | 'firefox' | 'webkit';
    headless: boolean;
    viewport: { width: number; height: number };
  };
  storage: {
    dir: string;
    screenshotsEnabled: boolean;
    maxRecordings: number;
  };
  replay: {
    selfHealEnabled: boolean;
    defaultTimeout: number;
    retryCount: number;
  };
}

function loadConfig(): ReplaybotConfig {
  const defaults: ReplaybotConfig = {
    llm: {
      provider: process.env.REPLAYBOT_LLM_PROVIDER ?? 'anthropic',
      fastModel: process.env.REPLAYBOT_FAST_MODEL ?? 'claude-haiku-4-5-20251001',
      balancedModel: process.env.REPLAYBOT_BALANCED_MODEL ?? 'claude-sonnet-4-6',
      premiumModel: process.env.REPLAYBOT_PREMIUM_MODEL ?? 'claude-opus-4-6',
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    },
    browser: {
      type: (process.env.REPLAYBOT_BROWSER as ReplaybotConfig['browser']['type']) ?? 'chromium',
      headless: process.env.REPLAYBOT_HEADLESS !== 'false',
      viewport: { width: 1280, height: 720 },
    },
    storage: {
      dir: process.env.REPLAYBOT_STORAGE_DIR ?? '.replaybot',
      screenshotsEnabled: process.env.REPLAYBOT_SCREENSHOTS !== 'false',
      maxRecordings: Number(process.env.REPLAYBOT_MAX_RECORDINGS) || 100,
    },
    replay: {
      selfHealEnabled: process.env.REPLAYBOT_SELF_HEAL !== 'false',
      defaultTimeout: Number(process.env.REPLAYBOT_TIMEOUT) || 30000,
      retryCount: Number(process.env.REPLAYBOT_RETRY_COUNT) || 1,
    },
  };

  // Try loading config file
  try {
    const configPath = resolve(process.env.REPLAYBOT_CONFIG ?? 'replaybot.config.json');
    const raw = require('fs').readFileSync(configPath, 'utf-8');
    const file = JSON.parse(raw);
    return deepMerge(defaults, file as Record<string, unknown>);
  } catch {
    return defaults;
  }
}

function deepMerge(target: ReplaybotConfig, source: Record<string, unknown>): ReplaybotConfig {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && result[key] && typeof result[key] === 'object') {
      result[key] = { ...(result[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as unknown as ReplaybotConfig;
}

// ── Playwright Auto-Install ────────────────────────────────────

function ensurePlaywrightBrowsers(): void {
  try {
    execSync('npx playwright install --with-deps chromium', {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch {
    // If auto-install fails, browsers may already be installed
    console.error('[replaybot] Playwright browser install check completed (may already be installed)');
  }
}

// ── Stub LLM Provider ──────────────────────────────────────────

class AnthropicStubProvider implements LLMProvider {
  name = 'anthropic-stub';

  async complete() {
    return { content: '{}', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async *stream() {
    yield { type: 'done' as const };
  }

  supportsVision() { return true; }
  supportsToolUse() { return true; }
  maxContextTokens() { return 200_000; }
}

// ── MCP Server ─────────────────────────────────────────────────

export class ReplaybotServer {
  private server: Server;
  private config: ReplaybotConfig;
  private browser: BrowserController | null = null;
  private context: AgentContext | null = null;
  private credentials: Credentials | undefined;
  private recordingManager: RecordingManager;
  private reportGenerator: ReportGenerator;
  private playwrightInstalled = false;

  constructor() {
    this.config = loadConfig();
    this.recordingManager = new RecordingManager();
    this.reportGenerator = new ReportGenerator();

    this.server = new Server(
      { name: 'replaybot', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    this.registerTools();
    this.registerResources();
    this.registerPrompts();

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }

  private async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    if (this.context) {
      await this.context.sitemap.save().catch(() => {});
      await this.context.pageState.save().catch(() => {});
    }
    process.exit(0);
  }

  // ── Lazy Browser Init ──

  private async ensureContext(): Promise<AgentContext> {
    if (this.context) return this.context;

    // Auto-install Playwright browsers on first use
    if (!this.playwrightInstalled) {
      ensurePlaywrightBrowsers();
      this.playwrightInstalled = true;
    }

    this.browser = new BrowserController();
    await this.browser.launch({
      headless: this.config.browser.headless,
      browserType: this.config.browser.type,
      viewport: this.config.browser.viewport,
    });

    const observer = new PageObserver();
    const actions = new ActionExecutor(this.browser.currentPage());
    const provider = new AnthropicStubProvider();
    const llmConfig: LLMConfig = {
      provider: this.config.llm.provider,
      fastModel: this.config.llm.fastModel,
      balancedModel: this.config.llm.balancedModel,
      premiumModel: this.config.llm.premiumModel,
      apiKey: this.config.llm.apiKey,
    };
    const llm = new LLMClient(provider, llmConfig);
    const pageState = new PageStateManager();
    const sitemap = new SiteMapManager();

    // Load persisted state
    await pageState.load().catch(() => {});
    await sitemap.load().catch(() => {});

    this.context = {
      browser: this.browser,
      observer,
      actions,
      llm,
      pageState,
      sitemap,
      credentials: this.credentials,
    };

    return this.context;
  }

  // ── Tool Registration ──

  private registerTools(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'scout_app',
          description: 'Quickly explore a web application using breadth-first search to discover pages, forms, and navigation structure.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              url: { type: 'string', description: 'Entry URL to start exploring from' },
              max_pages: { type: 'number', description: 'Maximum pages to discover (default: 50)' },
              max_depth: { type: 'number', description: 'Maximum click depth from entry page (default: 5)' },
              exclude_patterns: { type: 'array', items: { type: 'string' }, description: 'URL patterns to skip' },
              stay_within_domain: { type: 'boolean', description: 'Only explore same domain (default: true)' },
            },
            required: ['url'],
          },
        },
        {
          name: 'explore_page',
          description: 'Deep analysis of a specific page — identifies forms, interactive elements, validation rules, and suggests test scenarios.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              url: { type: 'string', description: 'Page URL to analyze' },
              focus: { type: 'string', description: 'Area to focus on (e.g., "the signup form")' },
            },
            required: ['url'],
          },
        },
        {
          name: 'plan_test',
          description: 'Create a structured test plan from a natural language description.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              goal: { type: 'string', description: 'What to test (e.g., "Test user signup with valid inputs")' },
              base_url: { type: 'string', description: 'Application base URL' },
            },
            required: ['goal'],
          },
        },
        {
          name: 'execute_exploration',
          description: 'Execute a test plan by driving the browser step-by-step. Records all actions.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              plan_id: { type: 'string', description: 'ID of a previously created test plan' },
              goal: { type: 'string', description: 'Or provide a goal directly' },
              parameters: { type: 'object', description: 'Parameter values' },
              save_recording: { type: 'boolean', description: 'Save for replay (default: true)' },
            },
          },
        },
        {
          name: 'replay_test',
          description: 'Replay a recorded test deterministically. Self-heals broken selectors if enabled.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              recording_id: { type: 'string', description: 'Recording ID to replay' },
              parameters: { type: 'object', description: 'Override parameter values' },
              headed: { type: 'boolean', description: 'Show browser (default: false)' },
              self_heal: { type: 'boolean', description: 'Fix broken selectors (default: true)' },
              slow_motion: { type: 'number', description: 'Delay between actions in ms' },
            },
            required: ['recording_id'],
          },
        },
        {
          name: 'create_replay',
          description: 'Create a replayable test by combining existing recordings. Describe what to test in natural language.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              description: { type: 'string', description: 'NL description of the test' },
              parameters: { type: 'object', description: 'Parameter values' },
              source_recordings: { type: 'array', items: { type: 'string' }, description: 'Recording IDs to draw from' },
            },
            required: ['description'],
          },
        },
        {
          name: 'list_recordings',
          description: 'List all saved test recordings.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              filter: { type: 'string', description: 'Filter by name or description' },
            },
          },
        },
        {
          name: 'get_sitemap',
          description: 'Return the discovered navigation graph of the application.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              format: { type: 'string', enum: ['summary', 'detailed', 'graph'], description: 'Output format (default: summary)' },
            },
          },
        },
        {
          name: 'provide_credentials',
          description: 'Supply authentication credentials for auth-gated pages.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              username: { type: 'string' },
              email: { type: 'string' },
              password: { type: 'string' },
              storage_state_path: { type: 'string', description: 'Path to Playwright storage state JSON' },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'scout_app': return await this.handleScoutApp(args);
          case 'explore_page': return await this.handleExplorePage(args);
          case 'plan_test': return await this.handlePlanTest(args);
          case 'execute_exploration': return await this.handleExecuteExploration(args);
          case 'replay_test': return await this.handleReplayTest(args);
          case 'create_replay': return await this.handleCreateReplay(args);
          case 'list_recordings': return await this.handleListRecordings(args);
          case 'get_sitemap': return await this.handleGetSitemap(args);
          case 'provide_credentials': return await this.handleProvideCredentials(args);
          default:
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    });
  }

  // ── Tool Handlers ──

  private async handleScoutApp(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const scout = new ScoutAgent(ctx);

    await scout.scoutApp(String(args.url), {
      maxPages: Number(args.max_pages) || 50,
      maxDepth: Number(args.max_depth) || 5,
      stayWithinDomain: args.stay_within_domain !== false,
      excludePatterns: Array.isArray(args.exclude_patterns) ? args.exclude_patterns.map(String) : [],
    });

    const sitemap = ctx.sitemap.getSiteMap();
    const pages = [...sitemap.pages.values()];
    const authGated = pages.filter((p) => p.isAuthGated);
    const withForms = pages.filter((p) => p.forms.length > 0);

    const summary = [
      `Discovered ${pages.length} pages.`,
      withForms.length > 0 ? `${withForms.length} pages with forms.` : '',
      authGated.length > 0 ? `${authGated.length} auth-gated pages.` : '',
      `${sitemap.edges.length} navigation links.`,
      '',
      'Pages:',
      ...pages.map((p) => `  - ${p.url}: ${p.pageType ?? 'unknown'} — ${p.title}${p.isAuthGated ? ' [AUTH]' : ''}${p.forms.length > 0 ? ` [${p.forms.length} forms]` : ''}`),
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handleExplorePage(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const explorer = new DeepExplorerAgent(ctx);

    const result = await explorer.explorePage(String(args.url));

    const summary = [
      `Page: ${result.url}`,
      `Type: ${result.analysis.pageType}`,
      `Purpose: ${result.analysis.purpose}`,
      '',
      `Interactive elements mapped: ${result.analysis.interactionMap.length}`,
      `Forms analyzed: ${result.analysis.formAnalyses.length}`,
      `Dynamic regions: ${result.analysis.dynamicRegions.length}`,
      `Predictions verified: ${result.verified.length}`,
      '',
      result.analysis.suggestedTestScenarios.length > 0
        ? `Suggested test scenarios:\n${result.analysis.suggestedTestScenarios.map((s) => `  - ${s}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handlePlanTest(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const planner = new PlannerAgent(ctx);
    const sitemap = ctx.sitemap.getSiteMap();

    const plan = await planner.planTest(String(args.goal), sitemap);

    const summary = [
      `Test Plan: ${plan.goal}`,
      `ID: ${plan.id}`,
      '',
      plan.preconditions.length > 0 ? `Preconditions:\n${plan.preconditions.map((p) => `  - ${p}`).join('\n')}` : '',
      plan.parameters.length > 0 ? `Parameters:\n${plan.parameters.map((p) => `  - {{${p.name}}} (${p.type}): ${p.description} [default: ${p.defaultValue}]`).join('\n')}` : '',
      '',
      `Steps (${plan.steps.length}):`,
      ...plan.steps.map((s) => `  ${s.order}. [${s.action.type}] ${s.description}${s.onFailure !== 'abort' ? ` (on fail: ${s.onFailure})` : ''}`),
      '',
      `Assertions (${plan.assertions.length}):`,
      ...plan.assertions.map((a) => `  - After step ${a.afterStepId}: ${a.description}`),
      plan.subPlans ? `\n(Split into ${(plan.subPlans.length + 1)} sub-plans due to length)` : '',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handleExecuteExploration(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const planner = new PlannerAgent(ctx);
    const sitemap = ctx.sitemap.getSiteMap();

    const goal = String(args.goal ?? args.plan_id ?? 'explore');
    const plan = await planner.planTest(goal, sitemap);
    const result = await planner.executePlan(plan, {
      parameterValues: (args.parameters as Record<string, string>) ?? undefined,
    });

    const summary = [
      `Execution: ${result.success ? 'PASSED' : 'FAILED'}`,
      `Steps: ${result.stepsExecuted} executed, ${result.stepsFailed} failed, ${result.stepsSkipped} skipped`,
      `Assertions: ${result.assertionsPassed} passed, ${result.assertionsFailed} failed`,
      result.recording ? `Recording saved: ${result.recording.id} ("${result.recording.name}")` : '',
      result.errors.length > 0 ? `\nErrors:\n${result.errors.map((e) => `  - ${e.stepId}: ${e.error}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handleReplayTest(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const replay = new ReplayAgent(ctx);

    const result = await replay.replayRecording(
      String(args.recording_id),
      (args.parameters as Record<string, string>) ?? undefined,
      {
        headed: args.headed === true,
        selfHeal: args.self_heal !== false,
        slowMotion: Number(args.slow_motion) || 0,
      },
    );

    const mcpSummary = this.reportGenerator.toMCPSummary(result);
    const markdown = this.reportGenerator.toMarkdown(result);

    return { content: [{ type: 'text', text: `${mcpSummary.narrative}\n\n${markdown}` }] };
  }

  private async handleCreateReplay(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const execution = new ExecutionAgent(ctx);

    const plan = await execution.createExecution(
      String(args.description),
      {
        parameters: (args.parameters as Record<string, string>) ?? undefined,
        recordings: Array.isArray(args.source_recordings) ? args.source_recordings.map(String) : undefined,
      },
    );

    const summary = [
      `Execution Plan: ${plan.description}`,
      `ID: ${plan.id}`,
      `Derived from: ${plan.derivedFrom.length} recording(s)`,
      `Actions: ${plan.actions.length}`,
      `Assertions: ${plan.assertions.length}`,
      plan.breakpoints.length > 0 ? `Breakpoints: ${plan.breakpoints.length} (manual intervention needed)` : '',
      '',
      'Actions:',
      ...plan.actions.map((a) => `  ${a.order + 1}. [${a.type}] ${a.description}`),
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handleListRecordings(args: Record<string, unknown> = {}) {
    let recordings = await this.recordingManager.listRecordings();
    const filter = args.filter ? String(args.filter).toLowerCase() : '';

    if (filter) {
      recordings = recordings.filter(
        (r) => r.name.toLowerCase().includes(filter) || r.description.toLowerCase().includes(filter),
      );
    }

    if (recordings.length === 0) {
      return { content: [{ type: 'text', text: 'No recordings found.' }] };
    }

    const summary = recordings.map(
      (r) => `- **${r.name}** (${r.id})\n  ${r.description}\n  ${r.actionCount} actions, ${r.assertionCount} assertions | ${r.createdAt}`,
    ).join('\n\n');

    return { content: [{ type: 'text', text: `${recordings.length} recording(s):\n\n${summary}` }] };
  }

  private async handleGetSitemap(args: Record<string, unknown> = {}) {
    const ctx = await this.ensureContext();
    const sitemap = ctx.sitemap.getSiteMap();
    const format = String(args.format ?? 'summary');

    if (sitemap.pages.size === 0) {
      return { content: [{ type: 'text', text: 'No sitemap data. Run scout_app first to discover pages.' }] };
    }

    if (format === 'detailed') {
      const pages = [...sitemap.pages.values()].map((p) => ({
        url: p.url,
        title: p.title,
        type: p.pageType,
        authGated: p.isAuthGated,
        forms: p.forms.length,
        elements: p.interactiveElements.length,
        links: p.links.length,
        deepAnalysis: !!p.deepAnalysis,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ pages, edges: sitemap.edges }, null, 2) }] };
    }

    if (format === 'graph') {
      const edges = sitemap.edges.map((e) => `${e.from} → ${e.to} (${e.action})`);
      return { content: [{ type: 'text', text: `Navigation Graph:\n${edges.join('\n')}` }] };
    }

    // Summary (default)
    const pages = [...sitemap.pages.values()];
    const summary = [
      `Sitemap: ${pages.length} pages, ${sitemap.edges.length} edges`,
      `Entry: ${sitemap.entryUrl}`,
      '',
      ...pages.map((p) => `- ${p.url}: ${p.pageType ?? '?'} — ${p.title}${p.isAuthGated ? ' [AUTH]' : ''}${p.forms.length > 0 ? ` [${p.forms.length} forms]` : ''}`),
    ].join('\n');

    return { content: [{ type: 'text', text: summary }] };
  }

  private async handleProvideCredentials(args: Record<string, unknown> = {}) {
    this.credentials = {
      username: args.username ? String(args.username) : undefined,
      email: args.email ? String(args.email) : undefined,
      password: String(args.password ?? ''),
    };

    if (this.context) {
      this.context.credentials = this.credentials;
    }

    // Load storage state if provided
    if (args.storage_state_path && this.browser) {
      await this.browser.loadStorageState(String(args.storage_state_path));
      return { content: [{ type: 'text', text: 'Credentials set and storage state loaded.' }] };
    }

    return { content: [{ type: 'text', text: 'Credentials stored. They will be used for auto-login on auth-gated pages.' }] };
  }

  // ── Resource Registration ──

  private registerResources(): void {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'replaybot://recordings',
          name: 'Test Recordings',
          description: 'All saved Replaybot test recordings',
          mimeType: 'application/json',
        },
        {
          uri: 'replaybot://sitemap',
          name: 'Application Sitemap',
          description: 'Discovered navigation graph',
          mimeType: 'application/json',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri === 'replaybot://recordings') {
        const recordings = await this.recordingManager.listRecordings();
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(recordings, null, 2),
          }],
        };
      }

      if (uri === 'replaybot://sitemap') {
        if (!this.context) {
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ message: 'No sitemap data. Run scout_app first.' }),
            }],
          };
        }
        const sitemap = this.context.sitemap.getSiteMap();
        const serialized = {
          entryUrl: sitemap.entryUrl,
          pageCount: sitemap.pages.size,
          edgeCount: sitemap.edges.length,
          pages: [...sitemap.pages.values()].map((p) => ({
            url: p.url, title: p.title, type: p.pageType, authGated: p.isAuthGated,
            forms: p.forms.length, elements: p.interactiveElements.length,
          })),
          edges: sitemap.edges,
        };
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(serialized, null, 2),
          }],
        };
      }

      // Handle replaybot://recordings/{id}
      const recordingMatch = uri.match(/^replaybot:\/\/recordings\/(.+)$/);
      if (recordingMatch) {
        const recording = await this.recordingManager.loadRecording(recordingMatch[1]);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(recording, null, 2),
          }],
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    });
  }

  // ── Prompt Registration ──

  private registerPrompts(): void {
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'explore-app',
          description: 'Explore a web application and build a complete sitemap with deep analysis',
          arguments: [
            { name: 'url', description: 'Application URL to explore', required: true },
          ],
        },
        {
          name: 'test-flow',
          description: 'Plan and execute a test for a specific user flow',
          arguments: [
            { name: 'goal', description: 'What to test (e.g., "user signup")', required: true },
            { name: 'url', description: 'Application URL (optional if already scouted)', required: false },
          ],
        },
        {
          name: 'regression-check',
          description: 'Replay all saved recordings to check for regressions',
          arguments: [
            { name: 'filter', description: 'Filter recordings by name (optional)', required: false },
          ],
        },
      ],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'explore-app':
          return {
            messages: [{
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `I want to explore the web application at ${args?.url ?? 'URL'} and understand its structure.

Please:
1. Use scout_app to discover all pages and navigation
2. Use explore_page on the most important pages (forms, interactive pages)
3. Summarize what you found: pages, forms, auth gates, suggested test scenarios

Start with scout_app now.`,
              },
            }],
          };

        case 'test-flow':
          return {
            messages: [{
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `I want to test: "${args?.goal ?? 'the main user flow'}"${args?.url ? ` on ${args.url}` : ''}.

Please:
1. ${args?.url ? `First scout_app at ${args.url} if not already done` : 'Check the sitemap with get_sitemap'}
2. Use plan_test to create a test plan for this goal
3. Show me the plan and ask for my approval
4. Once approved, use execute_exploration to run the test
5. Show me the results

Start now.`,
              },
            }],
          };

        case 'regression-check':
          return {
            messages: [{
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `I want to run a regression check on all saved test recordings${args?.filter ? ` matching "${args.filter}"` : ''}.

Please:
1. Use list_recordings${args?.filter ? ` with filter "${args.filter}"` : ''} to find all tests
2. For each recording, use replay_test to run it
3. Collect all results and give me a summary:
   - Total tests run
   - Passed / Failed / Self-healed
   - Details of any failures
   - Self-healing report if any selectors were auto-fixed

Start with list_recordings now.`,
              },
            }],
          };

        default:
          throw new Error(`Unknown prompt: ${name}`);
      }
    });
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const server = new ReplaybotServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start Replaybot MCP server:', err);
  process.exit(1);
});
