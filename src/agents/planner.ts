import { BaseAgent, type AgentContext, type AgentBudget } from './types.js';
import { DeepExplorerAgent } from './deep-explorer.js';
import type { SiteMap } from '../state/sitemap.js';
import type { LLMResponse } from '../llm/interface.js';
import {
  RecordingManager,
  type Recording,
  type ActionRecord,
  type AssertionRecord,
  type ParameterDef,
  type ActionType,
} from '../state/recordings.js';
import { ElementAssertionEngine } from '../assertions/element.js';
import type { SelectorChain, SelectorEntry } from '../types/index.js';

// ── Plan Types ──────────────────────────────────────────────────

const MAX_STEPS_PER_PLAN = 20;

export interface TestPlan {
  id: string;
  goal: string;
  preconditions: string[];
  parameters: ParameterDef[];
  steps: TestStep[];
  assertions: PlannedAssertion[];
  subPlans?: TestPlan[]; // Split when steps exceed MAX_STEPS_PER_PLAN
}

export interface TestStep {
  id: string;
  order: number;
  description: string;
  action: {
    type: ActionType;
    targetDescription: string;
    value?: string;
    url?: string; // for navigate actions
  };
  expectedOutcome: string;
  onFailure: 'abort' | 'skip' | 'retry';
  navigationRequired?: {
    from: string;
    to: string;
  };
}

export interface PlannedAssertion {
  afterStepId: string;
  type: 'element_visible' | 'text_content' | 'url_match' | 'title_match' | 'element_count' | 'attribute' | 'visual' | 'custom';
  description: string;
  targetDescription: string;
  expected: string;
}

export interface ExecutionResult {
  plan: TestPlan;
  recording: Recording;
  success: boolean;
  stepsExecuted: number;
  stepsFailed: number;
  stepsSkipped: number;
  assertionsPassed: number;
  assertionsFailed: number;
  errors: Array<{ stepId: string; error: string }>;
}

export interface PlannerOptions {
  signal?: AbortSignal;
  captureScreenshots?: boolean;
  parameterValues?: Record<string, string>;
  recordingName?: string;
}

// ── Planner Agent ───────────────────────────────────────────────

export class PlannerAgent extends BaseAgent {
  name = 'planner';
  role = 'Test plan generation and collaborative execution';

  private recordingManager: RecordingManager;
  private assertionEngine: ElementAssertionEngine;

  constructor(context: AgentContext, budget?: AgentBudget) {
    super(context, budget ?? { maxTokens: 200_000, maxTimeMs: 600_000 });
    this.recordingManager = new RecordingManager();
    this.assertionEngine = new ElementAssertionEngine();
  }

  /**
   * Generate a test plan from a natural language goal and the current sitemap.
   * Uses Sonnet/Opus-tier LLM to break goal into ordered steps with assertions.
   */
  async planTest(goal: string, sitemap: SiteMap): Promise<TestPlan> {
    this.startTime = Date.now();

    // Build a sitemap summary for the LLM
    const sitemapSummary = this.buildSitemapSummary(sitemap);

    const prompt = `Create a test plan for the following goal. Respond with JSON only, no markdown.

Goal: "${goal}"

Available sitemap:
${sitemapSummary}

Create a detailed test plan with the following JSON structure:
{
  "goal": "${goal}",
  "preconditions": ["<things that must be true before the test>"],
  "parameters": [
    {
      "name": "<parameter name>",
      "description": "<what this parameter is>",
      "type": "<string|number|boolean|email|password>",
      "defaultValue": "<a realistic default>"
    }
  ],
  "steps": [
    {
      "order": 1,
      "description": "<what to do>",
      "action": {
        "type": "<click|type|select|hover|scroll|navigate|wait>",
        "targetDescription": "<description of the element to interact with>",
        "value": "<value to type/select, or URL for navigate, use {{param_name}} for parameters>"
      },
      "expectedOutcome": "<what should happen after this step>",
      "onFailure": "<abort|skip|retry>",
      "navigationRequired": {
        "from": "<current expected page URL or pattern>",
        "to": "<page URL where action happens>"
      }
    }
  ],
  "assertions": [
    {
      "afterStepId": "<step order number as string>",
      "type": "<element_visible|text_content|url_match|title_match|element_count|attribute>",
      "description": "<what we're checking>",
      "targetDescription": "<element to check, or empty for URL/title checks>",
      "expected": "<expected value>"
    }
  ]
}

Guidelines:
- Include navigation steps when moving between pages
- Generate precondition steps (like login) if the target pages are auth-gated
- Use parameters for user-specific values (emails, passwords, names)
- Include assertions after important actions
- Set onFailure to "abort" for critical steps, "skip" for non-critical, "retry" for flaky operations
- Be specific in targetDescription (e.g., "the email input field in the login form" not just "email input")
- IMPORTANT: Keep the plan to ${MAX_STEPS_PER_PLAN} steps or fewer. If the flow requires more, focus on the most critical path.`;

    const response = await this.context.llm.complete({
      systemPrompt: 'You are a web application test planner. Generate detailed, executable test plans. Respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      modelTier: 'balanced',
      agentId: this.name,
      temperature: 0,
      maxTokens: 4000,
    });

    const plan = this.parsePlan(response, goal);

    // Split into sub-plans if exceeding max steps
    if (plan.steps.length > MAX_STEPS_PER_PLAN) {
      return this.splitIntoSubPlans(plan);
    }

    return plan;
  }

  /**
   * Split a large plan into sub-plans of MAX_STEPS_PER_PLAN steps each.
   * Each sub-plan inherits parameters and preconditions from the parent.
   */
  private splitIntoSubPlans(plan: TestPlan): TestPlan {
    const subPlans: TestPlan[] = [];
    const totalSteps = plan.steps;

    for (let i = 0; i < totalSteps.length; i += MAX_STEPS_PER_PLAN) {
      const chunk = totalSteps.slice(i, i + MAX_STEPS_PER_PLAN);
      const partNum = Math.floor(i / MAX_STEPS_PER_PLAN) + 1;
      const totalParts = Math.ceil(totalSteps.length / MAX_STEPS_PER_PLAN);

      // Collect assertions that belong to this chunk's steps
      const stepIds = new Set(chunk.map((s) => String(s.order)));
      const stepIdSet = new Set(chunk.map((s) => s.id));
      const chunkAssertions = plan.assertions.filter(
        (a) => stepIds.has(a.afterStepId) || stepIdSet.has(a.afterStepId),
      );

      subPlans.push({
        id: `${plan.id}-part${partNum}`,
        goal: `${plan.goal} (part ${partNum}/${totalParts})`,
        preconditions: partNum === 1 ? plan.preconditions : [`Part ${partNum - 1} completed successfully`],
        parameters: plan.parameters,
        steps: chunk,
        assertions: chunkAssertions,
      });
    }

    return {
      ...plan,
      steps: plan.steps.slice(0, MAX_STEPS_PER_PLAN), // Root plan contains first chunk
      assertions: subPlans[0]?.assertions ?? [],
      subPlans: subPlans.length > 1 ? subPlans.slice(1) : undefined,
    };
  }

  /**
   * Refine an existing plan based on feedback (e.g., after a failed execution).
   */
  async refinePlan(plan: TestPlan, feedback: string): Promise<TestPlan> {
    const prompt = `Refine this test plan based on the feedback. Respond with the full updated JSON plan.

Current plan:
${JSON.stringify(plan, null, 2)}

Feedback: ${feedback}

Return the updated plan in the same JSON format. Only change what's necessary to address the feedback.`;

    const response = await this.context.llm.complete({
      systemPrompt: 'You are a web application test planner. Refine test plans based on execution feedback. Respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      modelTier: 'balanced',
      agentId: this.name,
      temperature: 0,
      maxTokens: 4000,
    });

    return this.parsePlan(response, plan.goal);
  }

  /**
   * Execute a test plan step by step, recording every action.
   * Uses the Explorer for page observation and the Assertion engine for verification.
   *
   * Collaborative loop:
   *   Planner sends step → observe page → find element → execute → verify → next step
   */
  async executePlan(plan: TestPlan, options?: PlannerOptions): Promise<ExecutionResult> {
    this.startTime = Date.now();
    const errors: ExecutionResult['errors'] = [];
    let stepsExecuted = 0;
    let stepsFailed = 0;
    let stepsSkipped = 0;
    let assertionsPassed = 0;
    let assertionsFailed = 0;

    // Start recording
    const baseUrl = this.extractBaseUrl(plan);
    const recordingName = options?.recordingName ?? plan.goal.slice(0, 60);
    this.recordingManager.startRecording(recordingName, baseUrl, plan.goal);

    // Resolve parameters
    const paramValues = this.resolveParameters(plan.parameters, options?.parameterValues);

    try {
      for (const step of plan.steps) {
        this.checkAborted(options?.signal);
        this.checkBudget();

        const result = await this.executeStep(step, paramValues, options);

        if (result.success) {
          stepsExecuted++;

          // Run assertions after this step
          const stepAssertions = plan.assertions.filter(
            (a) => a.afterStepId === String(step.order) || a.afterStepId === step.id,
          );
          for (const assertion of stepAssertions) {
            const assertResult = await this.executeAssertion(assertion);
            if (assertResult.pass) {
              assertionsPassed++;
            } else {
              assertionsFailed++;
            }
          }
        } else {
          stepsFailed++;
          errors.push({ stepId: step.id, error: result.error ?? 'Unknown error' });

          if (step.onFailure === 'abort') {
            break;
          } else if (step.onFailure === 'retry') {
            // Retry once
            const retryResult = await this.executeStep(step, paramValues, options);
            if (retryResult.success) {
              stepsExecuted++;
              stepsFailed--;
            } else {
              // Still failed after retry
            }
          } else {
            stepsSkipped++;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ stepId: 'execution', error: msg });
    }

    // Execute sub-plans if any (plans split due to > MAX_STEPS_PER_PLAN)
    if (plan.subPlans && stepsFailed === 0) {
      for (const subPlan of plan.subPlans) {
        this.checkAborted(options?.signal);
        this.checkBudget();

        for (const step of subPlan.steps) {
          this.checkAborted(options?.signal);
          this.checkBudget();

          const result = await this.executeStep(step, paramValues, options);
          if (result.success) {
            stepsExecuted++;
            const stepAssertions = subPlan.assertions.filter(
              (a) => a.afterStepId === String(step.order) || a.afterStepId === step.id,
            );
            for (const assertion of stepAssertions) {
              const assertResult = await this.executeAssertion(assertion);
              if (assertResult.pass) assertionsPassed++;
              else assertionsFailed++;
            }
          } else {
            stepsFailed++;
            errors.push({ stepId: step.id, error: result.error ?? 'Unknown error' });
            if (step.onFailure === 'abort') break;
            if (step.onFailure === 'skip') stepsSkipped++;
          }
        }

        if (stepsFailed > 0) break; // Stop sub-plan chain on failure
      }
    }

    // Stop recording
    const recording = this.recordingManager.stopRecording();

    // Auto-detect and parameterize
    const detectedParams = RecordingManager.detectParameters(recording);
    const finalRecording = RecordingManager.parameterize(recording, detectedParams);

    // Save recording
    await this.recordingManager.saveRecording(finalRecording);

    return {
      plan,
      recording: finalRecording,
      success: stepsFailed === 0 && errors.length === 0,
      stepsExecuted,
      stepsFailed,
      stepsSkipped,
      assertionsPassed,
      assertionsFailed,
      errors,
    };
  }

  // ── Step Execution ──

  private async executeStep(
    step: TestStep,
    paramValues: Record<string, string>,
    options?: PlannerOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const page = this.context.browser.currentPage();
    const startTime = Date.now();

    try {
      // Handle navigation if needed
      if (step.navigationRequired) {
        const targetUrl = this.resolveValue(step.navigationRequired.to, paramValues);
        if (page.url() !== targetUrl) {
          await this.context.browser.navigateTo(targetUrl);
          await this.context.browser.waitForNavigation().catch(() => {});
        }
      }

      // Take screenshot before (if enabled)
      let screenshotBefore: string | undefined;
      if (options?.captureScreenshots && this.recordingManager.isRecording()) {
        const actionId = `step-${step.order}`;
        const buf = await this.context.observer.takeScreenshot(page);
        screenshotBefore = await this.recordingManager.recordScreenshot(actionId, 'before', buf);
      }

      // Resolve the action value
      const resolvedValue = step.action.value
        ? this.resolveValue(step.action.value, paramValues)
        : undefined;

      // Find the target element using LLM-assisted selector resolution
      let selectors: SelectorChain | undefined;
      if (step.action.type !== 'navigate' && step.action.type !== 'scroll' && step.action.type !== 'wait') {
        selectors = await this.findElement(step.action.targetDescription);
      }

      // Execute the action
      switch (step.action.type) {
        case 'click':
          if (selectors) await this.context.actions.click(selectors);
          break;
        case 'type':
          if (selectors && resolvedValue !== undefined) {
            await this.context.actions.type(selectors, resolvedValue);
          }
          break;
        case 'select':
          if (selectors && resolvedValue !== undefined) {
            await this.context.actions.select(selectors, resolvedValue);
          }
          break;
        case 'hover':
          if (selectors) await this.context.actions.hover(selectors);
          break;
        case 'scroll':
          await this.context.actions.scroll(resolvedValue === 'up' ? 'up' : 'down');
          break;
        case 'navigate':
          if (resolvedValue) {
            await this.context.actions.navigate(resolvedValue);
          } else if (step.action.url) {
            await this.context.actions.navigate(this.resolveValue(step.action.url, paramValues));
          }
          break;
        case 'wait':
          await page.waitForTimeout(Number(resolvedValue) || 1000);
          break;
      }

      // Wait for any navigation/DOM updates
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const duration = Date.now() - startTime;

      // Record the action
      if (this.recordingManager.isRecording()) {
        this.recordingManager.recordAction({
          type: step.action.type,
          selectors,
          value: resolvedValue,
          description: step.description,
          url: page.url(),
          timestamp: startTime,
          duration,
          success: true,
          screenshotBefore,
        });
      }

      return { success: true };
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);

      // Record the failed action
      if (this.recordingManager.isRecording()) {
        this.recordingManager.recordAction({
          type: step.action.type,
          description: step.description,
          url: page.url(),
          timestamp: startTime,
          duration,
          success: false,
          error,
        });
      }

      return { success: false, error };
    }
  }

  // ── Element Finding ──

  /**
   * Use LLM to resolve a natural language element description to selectors.
   * Observes the page and asks the LLM to identify the best selectors.
   */
  private async findElement(targetDescription: string): Promise<SelectorChain> {
    const page = this.context.browser.currentPage();

    // Get interactive elements on the page
    const elements = await this.context.observer.getInteractiveElements(page);
    const forms = await this.context.observer.getFormFields(page);

    const elementSummary = elements
      .slice(0, 40)
      .map((e, i) => `${i + 1}. <${e.tag}> selector="${e.selector}" text="${e.text ?? ''}" type="${e.type ?? ''}" aria="${e.ariaLabel ?? ''}"`)
      .join('\n');

    const formSummary = forms
      .map((f, i) => `F${i + 1}. <${f.tag}> selector="${f.selector}" name="${f.name ?? ''}" type="${f.type}" label="${f.label ?? ''}" placeholder="${f.placeholder ?? ''}"`)
      .join('\n');

    const prompt = `Find the element matching this description: "${targetDescription}"

Page URL: ${page.url()}

Interactive elements:
${elementSummary || 'none'}

Form fields:
${formSummary || 'none'}

Respond with JSON only:
{
  "selectors": [
    { "strategy": "<aria|testid|css|text>", "value": "<selector value>" }
  ]
}

Choose the most reliable selectors. Prefer aria > testid > css > text. Include 2-3 fallback selectors.`;

    try {
      const response = await this.context.llm.complete({
        systemPrompt: 'You are a web element selector generator. Given a description and available elements, return the best selectors. Respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        modelTier: 'fast',
        agentId: this.name,
        temperature: 0,
        maxTokens: 300,
      });

      const parsed = JSON.parse(response.content);
      const selectors: SelectorEntry[] = (parsed.selectors ?? []).map(
        (s: { strategy: string; value: string }) => ({
          strategy: s.strategy as SelectorEntry['strategy'],
          value: s.value,
        }),
      );

      if (selectors.length === 0) {
        throw new Error(`No selectors found for: ${targetDescription}`);
      }

      return { selectors, totalTimeout: 15000 };
    } catch (err) {
      // Fallback: try text-based selector
      return {
        selectors: [{ strategy: 'text', value: targetDescription }],
        totalTimeout: 10000,
      };
    }
  }

  // ── Assertion Execution ──

  private async executeAssertion(planned: PlannedAssertion): Promise<{ pass: boolean }> {
    const page = this.context.browser.currentPage();
    const startTime = Date.now();

    let result: { pass: boolean; message: string; expected?: string; actual?: string; duration: number };

    try {
      switch (planned.type) {
        case 'element_visible': {
          const selectors = await this.findElement(planned.targetDescription);
          result = await this.assertionEngine.assertVisible(page, selectors);
          break;
        }
        case 'text_content': {
          const selectors = await this.findElement(planned.targetDescription);
          result = await this.assertionEngine.assertText(page, selectors, planned.expected);
          break;
        }
        case 'url_match':
          result = await this.assertionEngine.assertUrl(page, planned.expected);
          break;
        case 'title_match':
          result = await this.assertionEngine.assertTitle(page, planned.expected);
          break;
        case 'element_count': {
          const selectors = await this.findElement(planned.targetDescription);
          const count = Number(planned.expected) || 0;
          result = await this.assertionEngine.assertElementCount(page, selectors, count);
          break;
        }
        case 'attribute': {
          const selectors = await this.findElement(planned.targetDescription);
          // Expected format: "attr=value"
          const [attr, ...valueParts] = planned.expected.split('=');
          const value = valueParts.join('=');
          result = await this.assertionEngine.assertAttribute(page, selectors, attr, value);
          break;
        }
        default:
          result = { pass: false, message: `Unknown assertion type: ${planned.type}`, duration: 0 };
      }
    } catch (err) {
      result = {
        pass: false,
        message: `Assertion error: ${err instanceof Error ? err.message : String(err)}`,
        duration: Date.now() - startTime,
      };
    }

    // Record the assertion
    if (this.recordingManager.isRecording()) {
      this.recordingManager.recordAssertion({
        afterActionId: planned.afterStepId,
        type: planned.type,
        description: planned.description,
        expected: planned.expected,
        result: {
          pass: result.pass,
          message: result.message,
          expected: result.expected,
          actual: result.actual,
          duration: result.duration,
        },
        timestamp: Date.now(),
      });
    }

    return { pass: result.pass };
  }

  // ── Helpers ──

  private buildSitemapSummary(sitemap: SiteMap): string {
    const pages: string[] = [];
    for (const [url, page] of sitemap.pages) {
      const forms = page.forms.length > 0 ? ` [${page.forms.length} forms]` : '';
      const elements = page.interactiveElements.length > 0 ? ` [${page.interactiveElements.length} elements]` : '';
      const auth = page.isAuthGated ? ' [AUTH]' : '';
      pages.push(`- ${url}: ${page.pageType ?? 'unknown'} — ${page.title}${forms}${elements}${auth}`);
    }

    const edges = sitemap.edges.slice(0, 30).map((e) => `  ${e.from} → ${e.to} (${e.action})`);

    return `Pages (${sitemap.pages.size}):\n${pages.join('\n')}\n\nNavigation edges:\n${edges.join('\n')}`;
  }

  private parsePlan(response: LLMResponse, goal: string): TestPlan {
    try {
      const parsed = JSON.parse(response.content);
      return {
        id: `plan-${Date.now()}`,
        goal: parsed.goal ?? goal,
        preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : [],
        parameters: Array.isArray(parsed.parameters)
          ? parsed.parameters.map((p: Record<string, unknown>): ParameterDef => ({
              name: String(p.name ?? ''),
              description: String(p.description ?? ''),
              type: (p.type as ParameterDef['type']) ?? 'string',
              defaultValue: String(p.defaultValue ?? ''),
              constraints: p.constraints ? String(p.constraints) : undefined,
            }))
          : [],
        steps: Array.isArray(parsed.steps)
          ? parsed.steps.map((s: Record<string, unknown>, i: number): TestStep => ({
              id: `step-${i + 1}`,
              order: Number(s.order ?? i + 1),
              description: String(s.description ?? ''),
              action: {
                type: String((s.action as Record<string, unknown>)?.type ?? 'click') as ActionType,
                targetDescription: String((s.action as Record<string, unknown>)?.targetDescription ?? ''),
                value: (s.action as Record<string, unknown>)?.value
                  ? String((s.action as Record<string, unknown>).value)
                  : undefined,
                url: (s.action as Record<string, unknown>)?.url
                  ? String((s.action as Record<string, unknown>).url)
                  : undefined,
              },
              expectedOutcome: String(s.expectedOutcome ?? ''),
              onFailure: (s.onFailure as TestStep['onFailure']) ?? 'abort',
              navigationRequired: s.navigationRequired
                ? {
                    from: String((s.navigationRequired as Record<string, unknown>).from ?? ''),
                    to: String((s.navigationRequired as Record<string, unknown>).to ?? ''),
                  }
                : undefined,
            }))
          : [],
        assertions: Array.isArray(parsed.assertions)
          ? parsed.assertions.map((a: Record<string, unknown>): PlannedAssertion => ({
              afterStepId: String(a.afterStepId ?? ''),
              type: (a.type as PlannedAssertion['type']) ?? 'element_visible',
              description: String(a.description ?? ''),
              targetDescription: String(a.targetDescription ?? ''),
              expected: String(a.expected ?? ''),
            }))
          : [],
      };
    } catch {
      // Return minimal plan if parsing fails
      return {
        id: `plan-${Date.now()}`,
        goal,
        preconditions: [],
        parameters: [],
        steps: [],
        assertions: [],
      };
    }
  }

  private resolveParameters(
    params: ParameterDef[],
    overrides?: Record<string, string>,
  ): Record<string, string> {
    const values: Record<string, string> = {};
    for (const param of params) {
      values[param.name] = overrides?.[param.name] ?? param.defaultValue;
    }
    return values;
  }

  private resolveValue(template: string, params: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
  }

  private extractBaseUrl(plan: TestPlan): string {
    // Extract base URL from the first navigate step or first navigationRequired
    for (const step of plan.steps) {
      if (step.action.type === 'navigate' && step.action.value) {
        try {
          const url = new URL(step.action.value);
          return url.origin;
        } catch {
          return step.action.value;
        }
      }
      if (step.navigationRequired?.to) {
        try {
          const url = new URL(step.navigationRequired.to);
          return url.origin;
        } catch {
          return step.navigationRequired.to;
        }
      }
    }
    return '';
  }
}
