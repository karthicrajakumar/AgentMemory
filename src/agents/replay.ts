import { BaseAgent, type AgentContext, type AgentBudget } from './types.js';
import type { ExecutionPlan, ResolvedAction, ResolvedAssertion } from './execution.js';
import { RecordingManager, type Recording } from '../state/recordings.js';
import { ElementAssertionEngine } from '../assertions/element.js';
import { VisualAssertionEngine } from '../assertions/visual.js';
import type { SelectorChain, SelectorEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ── Types ──────────────────────────────────────────────────────

export interface ReplayOptions {
  headed?: boolean;
  slowMotion?: number;
  screenshotOnFailure?: boolean;
  screenshotEveryStep?: boolean;
  video?: boolean;
  timeout?: number;
  selfHeal?: boolean;
  selfHealModel?: 'fast' | 'balanced';
  retryCount?: number;
  abortOnFailure?: boolean;
  browserType?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
  signal?: AbortSignal;
  /** Called when a breakpoint is hit. Return to resume, throw to abort. */
  onBreakpoint?: (actionId: string, action: ResolvedAction) => Promise<void>;
}

export interface ReplayResult {
  id: string;
  planId: string;
  status: 'passed' | 'failed' | 'error' | 'self_healed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  actionResults: ActionReplayResult[];
  assertionResults: AssertionReplayResult[];
  selfHealedActions: SelfHealReport[];
  screenshots: Array<{ actionId: string; path: string }>;
  tracePath?: string;
  summary: ReplaySummary;
}

export interface ReplaySummary {
  totalActions: number;
  passedActions: number;
  failedActions: number;
  selfHealedActions: number;
  skippedActions: number;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
}

export interface ActionReplayResult {
  actionId: string;
  status: 'passed' | 'failed' | 'self_healed' | 'skipped';
  usedSelector: { strategy: string; value: string };
  durationMs: number;
  error?: string;
  screenshotPath?: string;
}

export interface AssertionReplayResult {
  afterActionId: string;
  type: string;
  description: string;
  pass: boolean;
  expected?: string;
  actual?: string;
  message: string;
  durationMs: number;
}

export interface SelfHealReport {
  actionId: string;
  originalSelectors: SelectorChain;
  healedSelector: { strategy: string; value: string };
  confidence: number;
  reasoning: string;
  requiresReview: boolean; // Always true
}

export interface SteppedReplay {
  currentStep(): ResolvedAction | null;
  next(): Promise<ActionReplayResult>;
  skip(): void;
  runToEnd(): Promise<ReplayResult>;
  abort(): Promise<ReplayResult>;
  getState(): { completed: number; remaining: number; currentPage: string };
}

// ── Defaults ──

const DEFAULT_REPLAY_OPTIONS: Required<Omit<ReplayOptions, 'signal' | 'onBreakpoint'>> = {
  headed: false,
  slowMotion: 0,
  screenshotOnFailure: true,
  screenshotEveryStep: false,
  video: false,
  timeout: 30000,
  selfHeal: true,
  selfHealModel: 'fast',
  retryCount: 1,
  abortOnFailure: true,
  browserType: 'chromium',
  viewport: { width: 1280, height: 720 },
};

const SCREENSHOTS_DIR = '.replaybot/screenshots/replays';

// ── Replay Agent ───────────────────────────────────────────────

export class ReplayAgent extends BaseAgent {
  name = 'replay';
  role = 'Deterministic playback of execution plans';

  private recordingManager: RecordingManager;
  private elementEngine: ElementAssertionEngine;
  private visualEngine: VisualAssertionEngine;

  constructor(context: AgentContext, budget?: AgentBudget) {
    super(context, budget ?? { maxTokens: 50_000, maxTimeMs: 600_000 });
    this.recordingManager = new RecordingManager();
    this.elementEngine = new ElementAssertionEngine();
    this.visualEngine = new VisualAssertionEngine();
  }

  /**
   * Replay an execution plan. No LLM at runtime except self-healing fallback.
   */
  async replay(plan: ExecutionPlan, options?: ReplayOptions): Promise<ReplayResult> {
    const opts = { ...DEFAULT_REPLAY_OPTIONS, ...options };
    this.startTime = Date.now();

    const resultId = uuidv4();
    const startedAt = new Date().toISOString();
    const actionResults: ActionReplayResult[] = [];
    const assertionResults: AssertionReplayResult[] = [];
    const selfHealedActions: SelfHealReport[] = [];
    const screenshots: Array<{ actionId: string; path: string }> = [];
    let tracePath: string | undefined;

    // Enable Playwright trace on failure detection (captured at end)
    const page = this.context.browser.currentPage();
    let traceStarted = false;

    try {
      for (const action of plan.actions) {
        this.checkAborted(opts.signal);
        this.checkBudget();

        // Check for breakpoint (manual intervention)
        if (plan.breakpoints.includes(action.id) && opts.onBreakpoint) {
          await opts.onBreakpoint(action.id, action);
        }

        // Slow motion delay
        if (opts.slowMotion > 0) {
          await new Promise((r) => setTimeout(r, opts.slowMotion));
        }

        // Execute the action with retry + self-heal
        const result = await this.executeActionWithFallback(action, opts, selfHealedActions);
        actionResults.push(result);

        // Screenshot
        if (opts.screenshotEveryStep || (opts.screenshotOnFailure && result.status === 'failed')) {
          const screenshotPath = await this.captureScreenshot(resultId, action.id);
          if (screenshotPath) {
            result.screenshotPath = screenshotPath;
            screenshots.push({ actionId: action.id, path: screenshotPath });
          }
        }

        // Run assertions for this action
        const actionAssertions = plan.assertions.filter((a) => a.afterActionId === action.id);
        for (const assertion of actionAssertions) {
          const assertResult = await this.executeAssertion(assertion);
          assertionResults.push(assertResult);
        }

        // Check abort on failure
        if (result.status === 'failed' && opts.abortOnFailure) {
          // Start trace for debugging if not already
          if (!traceStarted) {
            traceStarted = true;
            // Trace is captured as a screenshot of failure state
          }
          break;
        }
      }
    } catch (err) {
      // Capture trace on error
      const screenshotPath = await this.captureScreenshot(resultId, 'error');
      if (screenshotPath) {
        screenshots.push({ actionId: 'error', path: screenshotPath });
      }
    }

    // Generate trace file on failure
    const hasFailed = actionResults.some((r) => r.status === 'failed');
    if (hasFailed) {
      tracePath = await this.generateTraceFile(resultId, plan, actionResults);
    }

    // Build summary
    const summary = this.buildSummary(actionResults, assertionResults, selfHealedActions);

    // Determine overall status
    let status: ReplayResult['status'] = 'passed';
    if (actionResults.some((r) => r.status === 'failed')) {
      status = 'failed';
    } else if (selfHealedActions.length > 0) {
      status = 'self_healed';
    }

    return {
      id: resultId,
      planId: plan.id,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      actionResults,
      assertionResults,
      selfHealedActions,
      screenshots,
      tracePath,
      summary,
    };
  }

  /**
   * Replay a saved recording directly, resolving parameters.
   */
  async replayRecording(
    recordingId: string,
    params?: Record<string, string>,
    options?: ReplayOptions,
  ): Promise<ReplayResult> {
    const recording = await this.recordingManager.loadRecording(recordingId);

    // Convert recording to execution plan
    const resolvedParams: Record<string, string> = {};
    for (const param of recording.parameters) {
      resolvedParams[param.name] = params?.[param.name] ?? param.defaultValue;
    }

    const plan: ExecutionPlan = {
      id: uuidv4(),
      description: recording.description,
      derivedFrom: [recordingId],
      parameters: resolvedParams,
      actions: recording.actions.map((a, i) => ({
        id: `${recordingId}-${i}`,
        order: i,
        type: a.type,
        selectors: a.selectors ?? { selectors: [], totalTimeout: 15000 },
        value: a.value ? this.resolveTemplate(a.value, resolvedParams) : undefined,
        description: a.description,
        page: { url: a.url, fingerprint: '' },
        timeout: options?.timeout ?? 30000,
        sourceRecordingId: recordingId,
      })),
      assertions: recording.assertions.map((a) => ({
        afterActionId: a.afterActionId,
        type: a.type,
        selectors: a.selectors,
        expected: a.expected,
        timeout: 10000,
        description: a.description,
      })),
      navigationPlan: [],
      breakpoints: [],
    };

    return this.replay(plan, options);
  }

  /**
   * Create a stepped replay for interactive debugging.
   */
  startSteppedReplay(plan: ExecutionPlan, options?: ReplayOptions): SteppedReplay {
    const opts = { ...DEFAULT_REPLAY_OPTIONS, ...options };
    const actionResults: ActionReplayResult[] = [];
    const assertionResults: AssertionReplayResult[] = [];
    const selfHealedActions: SelfHealReport[] = [];
    const screenshots: Array<{ actionId: string; path: string }> = [];
    let currentIndex = 0;
    const resultId = uuidv4();
    const startedAt = new Date().toISOString();
    const agent = this;

    return {
      currentStep(): ResolvedAction | null {
        return currentIndex < plan.actions.length ? plan.actions[currentIndex] : null;
      },

      async next(): Promise<ActionReplayResult> {
        if (currentIndex >= plan.actions.length) {
          return { actionId: 'done', status: 'skipped', usedSelector: { strategy: 'none', value: 'none' }, durationMs: 0 };
        }

        const action = plan.actions[currentIndex];
        const result = await agent.executeActionWithFallback(action, opts, selfHealedActions);
        actionResults.push(result);

        // Run assertions
        const actionAssertions = plan.assertions.filter((a) => a.afterActionId === action.id);
        for (const assertion of actionAssertions) {
          const assertResult = await agent.executeAssertion(assertion);
          assertionResults.push(assertResult);
        }

        currentIndex++;
        return result;
      },

      skip(): void {
        if (currentIndex < plan.actions.length) {
          const action = plan.actions[currentIndex];
          actionResults.push({
            actionId: action.id,
            status: 'skipped',
            usedSelector: { strategy: 'none', value: 'none' },
            durationMs: 0,
          });
          currentIndex++;
        }
      },

      async runToEnd(): Promise<ReplayResult> {
        while (currentIndex < plan.actions.length) {
          await this.next();
          const lastResult = actionResults[actionResults.length - 1];
          if (lastResult.status === 'failed' && opts.abortOnFailure) break;
        }
        return agent.buildReplayResult(resultId, plan.id, startedAt, actionResults, assertionResults, selfHealedActions, screenshots);
      },

      async abort(): Promise<ReplayResult> {
        // Skip remaining
        while (currentIndex < plan.actions.length) {
          this.skip();
        }
        return agent.buildReplayResult(resultId, plan.id, startedAt, actionResults, assertionResults, selfHealedActions, screenshots);
      },

      getState() {
        const page = agent.context.browser.currentPage();
        return {
          completed: currentIndex,
          remaining: plan.actions.length - currentIndex,
          currentPage: page.url(),
        };
      },
    };
  }

  // ── Action Execution with Retry + Self-Heal ──

  private async executeActionWithFallback(
    action: ResolvedAction,
    opts: Required<Omit<ReplayOptions, 'signal' | 'onBreakpoint'>>,
    selfHealedActions: SelfHealReport[],
  ): Promise<ActionReplayResult> {
    const page = this.context.browser.currentPage();
    const start = Date.now();

    // 1. Verify current page matches expected
    if (action.page.url && page.url() !== action.page.url) {
      try {
        await this.context.browser.navigateTo(action.page.url);
        await this.context.browser.waitForNavigation().catch(() => {});
      } catch {
        // Try via sitemap path
        const path = this.context.sitemap.findPath(page.url(), action.page.url);
        if (path.length > 0) {
          await this.context.browser.navigateTo(action.page.url);
        }
      }
    }

    // 2. Wait before
    if (action.waitBefore) {
      await new Promise((r) => setTimeout(r, action.waitBefore));
    }

    // 3. Try to execute with retries
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= opts.retryCount; attempt++) {
      try {
        const selector = await this.executeAction(action);
        // Wait after
        if (action.waitAfter) {
          await new Promise((r) => setTimeout(r, action.waitAfter));
        }
        return {
          actionId: action.id,
          status: 'passed',
          usedSelector: selector,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < opts.retryCount) {
          // Retry with backoff
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    // 4. All retries failed — try self-healing
    if (opts.selfHeal && action.selectors.selectors.length > 0) {
      const healResult = await this.selfHeal(action, opts.selfHealModel);
      if (healResult) {
        selfHealedActions.push(healResult);
        try {
          // Try with healed selector
          const healedSelectors: SelectorChain = {
            selectors: [{ strategy: healResult.healedSelector.strategy as SelectorEntry['strategy'], value: healResult.healedSelector.value }],
            totalTimeout: action.timeout,
          };
          const healedAction = { ...action, selectors: healedSelectors };
          const selector = await this.executeAction(healedAction);
          if (action.waitAfter) {
            await new Promise((r) => setTimeout(r, action.waitAfter));
          }
          return {
            actionId: action.id,
            status: 'self_healed',
            usedSelector: selector,
            durationMs: Date.now() - start,
          };
        } catch {
          // Self-healing also failed
        }
      }
    }

    return {
      actionId: action.id,
      status: 'failed',
      usedSelector: { strategy: 'none', value: 'none' },
      durationMs: Date.now() - start,
      error: lastError,
    };
  }

  private async executeAction(action: ResolvedAction): Promise<{ strategy: string; value: string }> {
    const page = this.context.browser.currentPage();

    switch (action.type) {
      case 'click': {
        const result = await this.context.actions.click(action.selectors);
        if (!result.success) throw new Error(result.error ?? 'Click failed');
        return result.usedSelector;
      }
      case 'type': {
        const result = await this.context.actions.type(action.selectors, action.value ?? '');
        if (!result.success) throw new Error(result.error ?? 'Type failed');
        return result.usedSelector;
      }
      case 'select': {
        const result = await this.context.actions.select(action.selectors, action.value ?? '');
        if (!result.success) throw new Error(result.error ?? 'Select failed');
        return result.usedSelector;
      }
      case 'hover': {
        const result = await this.context.actions.hover(action.selectors);
        if (!result.success) throw new Error(result.error ?? 'Hover failed');
        return result.usedSelector;
      }
      case 'scroll': {
        const direction = action.value === 'up' ? 'up' : 'down';
        await this.context.actions.scroll(direction);
        return { strategy: 'native', value: `scroll-${direction}` };
      }
      case 'navigate': {
        const url = action.value ?? action.page.url;
        await this.context.actions.navigate(url);
        return { strategy: 'native', value: url };
      }
      case 'wait': {
        await page.waitForTimeout(Number(action.value) || 1000);
        return { strategy: 'native', value: 'wait' };
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  // ── Self-Healing ──

  private async selfHeal(
    action: ResolvedAction,
    modelTier: 'fast' | 'balanced',
  ): Promise<SelfHealReport | null> {
    try {
      const page = this.context.browser.currentPage();
      const elements = await this.context.observer.getInteractiveElements(page);

      const originalSelectors = action.selectors.selectors
        .map((s) => `${s.strategy}="${s.value}"`)
        .join(', ');

      const elementSummary = elements
        .slice(0, 40)
        .map((e, i) => `${i + 1}. <${e.tag}> selector="${e.selector}" text="${e.text ?? ''}" role="${e.role ?? ''}" aria="${e.ariaLabel ?? ''}"`)
        .join('\n');

      const prompt = `An element could not be found using these selectors: ${originalSelectors}

The action was: "${action.description}" (${action.type})

Current page URL: ${page.url()}

Available elements on the page:
${elementSummary}

Find the element that most likely matches the original action. Respond with JSON:
{
  "selector": { "strategy": "<css|text|aria|testid>", "value": "<selector>" },
  "confidence": <0.0-1.0>,
  "reasoning": "<why you chose this element>"
}

If you cannot find a matching element, respond with:
{ "selector": null, "confidence": 0, "reasoning": "<why>" }`;

      const response = await this.context.llm.complete({
        systemPrompt: 'You are a web element locator. Find elements that match descriptions on changed pages. Respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        modelTier,
        agentId: 'self-heal',
        temperature: 0,
        maxTokens: 300,
      });

      const parsed = JSON.parse(response.content);
      if (!parsed.selector) return null;

      return {
        actionId: action.id,
        originalSelectors: action.selectors,
        healedSelector: {
          strategy: parsed.selector.strategy,
          value: parsed.selector.value,
        },
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning ?? '',
        requiresReview: true, // Always requires human review
      };
    } catch {
      return null;
    }
  }

  // ── Assertions ──

  private async executeAssertion(assertion: ResolvedAssertion): Promise<AssertionReplayResult> {
    const page = this.context.browser.currentPage();
    const start = Date.now();

    try {
      switch (assertion.type) {
        case 'element_visible': {
          if (!assertion.selectors) throw new Error('No selectors for element assertion');
          const result = await this.elementEngine.assertVisible(page, assertion.selectors);
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: result.pass,
            message: result.message,
            durationMs: result.duration,
          };
        }
        case 'text_content': {
          if (!assertion.selectors) throw new Error('No selectors for text assertion');
          const result = await this.elementEngine.assertText(page, assertion.selectors, assertion.expected ?? '');
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: result.pass,
            expected: result.expected,
            actual: result.actual,
            message: result.message,
            durationMs: result.duration,
          };
        }
        case 'url_match': {
          const result = await this.elementEngine.assertUrl(page, assertion.expected ?? '');
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: result.pass,
            expected: result.expected,
            actual: result.actual,
            message: result.message,
            durationMs: result.duration,
          };
        }
        case 'title_match': {
          const result = await this.elementEngine.assertTitle(page, assertion.expected ?? '');
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: result.pass,
            expected: result.expected,
            actual: result.actual,
            message: result.message,
            durationMs: result.duration,
          };
        }
        case 'visual': {
          const diff = await this.visualEngine.compareToBaseline(
            page,
            assertion.screenshotBaseline ?? assertion.afterActionId,
          );
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: diff.pass,
            expected: `<= ${0.1}% diff`,
            actual: `${diff.diffPercent}% diff (${diff.diffPixelCount} pixels)`,
            message: diff.pass ? 'Visual match' : `Visual regression: ${diff.diffPercent}% diff`,
            durationMs: Date.now() - start,
          };
        }
        default:
          return {
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            description: assertion.description,
            pass: false,
            message: `Unsupported assertion type: ${assertion.type}`,
            durationMs: 0,
          };
      }
    } catch (err) {
      return {
        afterActionId: assertion.afterActionId,
        type: assertion.type,
        description: assertion.description,
        pass: false,
        message: `Assertion error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Helpers ──

  private async captureScreenshot(resultId: string, actionId: string): Promise<string | null> {
    try {
      const page = this.context.browser.currentPage();
      const dir = join(SCREENSHOTS_DIR, resultId);
      await mkdir(dir, { recursive: true });
      const filepath = join(dir, `${actionId}.png`);
      const buffer = await page.screenshot({ type: 'png' });
      await writeFile(filepath, buffer);
      return filepath;
    } catch {
      return null;
    }
  }

  private async generateTraceFile(
    resultId: string,
    plan: ExecutionPlan,
    actionResults: ActionReplayResult[],
  ): Promise<string | undefined> {
    try {
      const dir = join('.replaybot/traces');
      await mkdir(dir, { recursive: true });
      const filepath = join(dir, `${resultId}.json`);

      const trace = {
        id: resultId,
        planId: plan.id,
        description: plan.description,
        timestamp: new Date().toISOString(),
        actions: plan.actions.map((a, i) => ({
          ...a,
          result: actionResults[i] ?? { status: 'skipped' },
        })),
      };

      await writeFile(filepath, JSON.stringify(trace, null, 2), 'utf-8');
      return filepath;
    } catch {
      return undefined;
    }
  }

  private resolveTemplate(template: string, params: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
  }

  private buildSummary(
    actionResults: ActionReplayResult[],
    assertionResults: AssertionReplayResult[],
    selfHealedActions: SelfHealReport[],
  ): ReplaySummary {
    return {
      totalActions: actionResults.length,
      passedActions: actionResults.filter((r) => r.status === 'passed').length,
      failedActions: actionResults.filter((r) => r.status === 'failed').length,
      selfHealedActions: selfHealedActions.length,
      skippedActions: actionResults.filter((r) => r.status === 'skipped').length,
      totalAssertions: assertionResults.length,
      passedAssertions: assertionResults.filter((r) => r.pass).length,
      failedAssertions: assertionResults.filter((r) => !r.pass).length,
    };
  }

  private buildReplayResult(
    resultId: string,
    planId: string,
    startedAt: string,
    actionResults: ActionReplayResult[],
    assertionResults: AssertionReplayResult[],
    selfHealedActions: SelfHealReport[],
    screenshots: Array<{ actionId: string; path: string }>,
  ): ReplayResult {
    const summary = this.buildSummary(actionResults, assertionResults, selfHealedActions);
    let status: ReplayResult['status'] = 'passed';
    if (actionResults.some((r) => r.status === 'failed')) status = 'failed';
    else if (selfHealedActions.length > 0) status = 'self_healed';

    return {
      id: resultId,
      planId,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      actionResults,
      assertionResults,
      selfHealedActions,
      screenshots,
      summary,
    };
  }
}
