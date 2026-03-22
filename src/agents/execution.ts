import { BaseAgent, type AgentContext, type AgentBudget } from './types.js';
import {
  RecordingManager,
  type Recording,
  type ActionRecord,
  type AssertionRecord,
  type ParameterDef,
  type ActionType,
} from '../state/recordings.js';
import type { SiteMap, SiteMapEdge } from '../state/sitemap.js';
import type { SelectorChain, NavigationStep } from '../types/index.js';
import type { LLMResponse } from '../llm/interface.js';
import { v4 as uuidv4 } from 'uuid';

// ── Types ──────────────────────────────────────────────────────

export interface ExecutionPlan {
  id: string;
  description: string;
  derivedFrom: string[];
  parameters: Record<string, string>;
  actions: ResolvedAction[];
  assertions: ResolvedAssertion[];
  navigationPlan: NavigationStep[];
  breakpoints: string[]; // action IDs where execution pauses for manual intervention
}

export interface ResolvedAction {
  id: string;
  order: number;
  type: ActionType;
  selectors: SelectorChain;
  value?: string;
  description: string;
  page: {
    url: string;
    fingerprint: string;
  };
  waitBefore?: number;
  waitAfter?: number;
  timeout: number;
  sourceRecordingId?: string;
}

export interface ResolvedAssertion {
  afterActionId: string;
  type: AssertionRecord['type'];
  selectors?: SelectorChain;
  expected?: string;
  screenshotBaseline?: string;
  timeout: number;
  description: string;
}

export interface ExecutionOptions {
  parameters?: Record<string, string>;
  recordings?: string[];
  maxSteps?: number;
  startUrl?: string;
  dryRun?: boolean;
}

// ── Execution Agent ────────────────────────────────────────────

export class ExecutionAgent extends BaseAgent {
  name = 'execution';
  role = 'Synthesize replayable action sequences from recordings and NL descriptions';

  private recordingManager: RecordingManager;

  constructor(context: AgentContext, budget?: AgentBudget) {
    super(context, budget ?? { maxTokens: 150_000, maxTimeMs: 300_000 });
    this.recordingManager = new RecordingManager();
  }

  /**
   * Create an execution plan from a natural language description.
   * Searches saved recordings, merges relevant ones, resolves parameters.
   */
  async createExecution(
    description: string,
    options?: ExecutionOptions,
  ): Promise<ExecutionPlan> {
    this.startTime = Date.now();

    // 1. Find relevant recordings
    const allRecordings = await this.recordingManager.listRecordings();
    const candidates = options?.recordings
      ? allRecordings.filter((r) => options.recordings!.includes(r.id))
      : allRecordings;

    // Load full recordings
    const recordings: Recording[] = [];
    for (const summary of candidates) {
      try {
        const full = await this.recordingManager.loadRecording(summary.id);
        recordings.push(full);
      } catch {
        // Skip unloadable recordings
      }
    }

    // 2. Use LLM to match description to recordings and build a plan
    const plan = await this.synthesizePlan(description, recordings, options);

    return plan;
  }

  /**
   * Derive an execution plan from an existing recording with modifications.
   * e.g., "use a different email", "skip the newsletter step"
   */
  async deriveExecution(
    recordingId: string,
    modifications: string,
    options?: ExecutionOptions,
  ): Promise<ExecutionPlan> {
    this.startTime = Date.now();

    const recording = await this.recordingManager.loadRecording(recordingId);

    const prompt = `Modify this recording based on the instructions. Respond with JSON only.

Recording: "${recording.name}"
Description: "${recording.description}"
Parameters: ${JSON.stringify(recording.parameters)}

Actions (${recording.actions.length}):
${recording.actions.map((a, i) => `${i + 1}. [${a.type}] ${a.description} (value: ${a.value ?? 'none'})`).join('\n')}

Assertions (${recording.assertions.length}):
${recording.assertions.map((a) => `- After action ${a.afterActionId}: ${a.description} (expect: ${a.expected})`).join('\n')}

Modifications requested: "${modifications}"

Respond with:
{
  "description": "<updated description>",
  "parameterOverrides": { "<param_name>": "<new_value>" },
  "skipActionIndices": [<0-based indices of actions to skip>],
  "modifiedAssertions": [
    { "afterActionIndex": <0-based>, "type": "<assertion type>", "expected": "<new expected>", "description": "<description>" }
  ],
  "breakpointActionIndices": [<0-based indices where execution should pause for manual steps>]
}`;

    const response = await this.context.llm.complete({
      systemPrompt: 'You are a test execution planner. Modify existing test recordings based on instructions. Respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      modelTier: 'balanced',
      agentId: this.name,
      temperature: 0,
      maxTokens: 2000,
    });

    return this.applyModifications(recording, response, options);
  }

  // ── Private ──

  /**
   * Use LLM to select and merge recordings into an execution plan.
   */
  private async synthesizePlan(
    description: string,
    recordings: Recording[],
    options?: ExecutionOptions,
  ): Promise<ExecutionPlan> {
    if (recordings.length === 0) {
      return this.createEmptyPlan(description, options);
    }

    const recordingSummaries = recordings.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      actionCount: r.actions.length,
      parameters: r.parameters.map((p) => `${p.name} (${p.type})`),
      baseUrl: r.baseUrl,
      pages: r.metadata.pagesVisited,
    }));

    const sitemapSummary = this.buildSitemapSummary();

    const prompt = `Create an execution plan from saved recordings. Respond with JSON only.

Goal: "${description}"

Available recordings:
${JSON.stringify(recordingSummaries, null, 2)}

Sitemap pages:
${sitemapSummary}

Respond with:
{
  "selectedRecordingIds": ["<recording IDs to use, in order>"],
  "description": "<execution plan description>",
  "parameterOverrides": { "<param_name>": "<value>" },
  "skipActionsByRecording": { "<recording_id>": [<0-based action indices to skip>] },
  "assertionAdjustments": [
    { "recordingId": "<id>", "afterActionIndex": <0-based>, "type": "<type>", "expected": "<value>", "description": "<desc>" }
  ],
  "breakpointActionIndices": [<indices where manual intervention is needed>],
  "navigationHints": ["<any navigation notes>"]
}

Guidelines:
- Select recordings that are relevant to the goal
- You can select multiple recordings — they will be merged in order
- Override parameters to match the goal (e.g., invalid email for negative test)
- Skip actions that are irrelevant to the goal
- Adjust assertions to match expected outcomes
- Add breakpoints for actions that require manual intervention (e.g., email verification)`;

    const response = await this.context.llm.complete({
      systemPrompt: 'You are a test execution planner. Select and merge recordings into execution plans. Respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      modelTier: 'balanced',
      agentId: this.name,
      temperature: 0,
      maxTokens: 3000,
    });

    return this.buildPlanFromLLMResponse(response, recordings, options);
  }

  private buildPlanFromLLMResponse(
    response: LLMResponse,
    recordings: Recording[],
    options?: ExecutionOptions,
  ): ExecutionPlan {
    try {
      const parsed = JSON.parse(response.content);
      const selectedIds: string[] = parsed.selectedRecordingIds ?? [];
      const paramOverrides: Record<string, string> = {
        ...(parsed.parameterOverrides ?? {}),
        ...(options?.parameters ?? {}),
      };
      const skipMap: Record<string, number[]> = parsed.skipActionsByRecording ?? {};
      const breakpointIndices: number[] = parsed.breakpointActionIndices ?? [];

      // Merge actions from selected recordings in order
      const actions: ResolvedAction[] = [];
      const assertions: ResolvedAssertion[] = [];
      const derivedFrom: string[] = [];
      const allParams = new Map<string, ParameterDef>();
      let globalOrder = 0;

      for (const recId of selectedIds) {
        const recording = recordings.find((r) => r.id === recId);
        if (!recording) continue;
        derivedFrom.push(recId);

        const skipIndices = new Set(skipMap[recId] ?? []);

        // Collect parameters
        for (const param of recording.parameters) {
          if (!allParams.has(param.name)) allParams.set(param.name, param);
        }

        // Convert actions
        for (let i = 0; i < recording.actions.length; i++) {
          if (skipIndices.has(i)) continue;

          const action = recording.actions[i];
          const maxSteps = options?.maxSteps ?? 100;
          if (globalOrder >= maxSteps) break;

          // Check if page still exists in sitemap
          const pageExists = this.context.sitemap.hasPage(action.url);
          if (!pageExists) {
            console.warn(`[execution] Page ${action.url} no longer exists, skipping action: ${action.description}`);
            continue;
          }

          // Resolve parameter values in action value
          let resolvedValue = action.value;
          if (resolvedValue) {
            resolvedValue = this.resolveTemplate(resolvedValue, paramOverrides, allParams);
          }

          actions.push({
            id: `${recId}-action-${i}`,
            order: globalOrder++,
            type: action.type,
            selectors: action.selectors ?? { selectors: [], totalTimeout: 15000 },
            value: resolvedValue,
            description: action.description,
            page: {
              url: action.url,
              fingerprint: '',
            },
            timeout: 30000,
            sourceRecordingId: recId,
          });
        }

        // Convert assertions
        for (const assertion of recording.assertions) {
          assertions.push({
            afterActionId: assertion.afterActionId,
            type: assertion.type,
            selectors: assertion.selectors,
            expected: assertion.expected,
            timeout: 10000,
            description: assertion.description,
          });
        }
      }

      // Apply assertion adjustments from LLM
      const adjustments: Array<{ recordingId: string; afterActionIndex: number; type: string; expected: string; description: string }> =
        parsed.assertionAdjustments ?? [];
      for (const adj of adjustments) {
        assertions.push({
          afterActionId: `${adj.recordingId}-action-${adj.afterActionIndex}`,
          type: (adj.type as ResolvedAssertion['type']) ?? 'element_visible',
          expected: adj.expected,
          timeout: 10000,
          description: adj.description ?? '',
        });
      }

      // Build navigation plan
      const navigationPlan = this.buildNavigationPlan(actions, options?.startUrl);

      // Resolve final parameters
      const resolvedParams: Record<string, string> = {};
      for (const [name, def] of allParams) {
        resolvedParams[name] = paramOverrides[name] ?? options?.parameters?.[name] ?? def.defaultValue;
      }

      // Build breakpoints list
      const breakpoints = breakpointIndices
        .filter((i) => i < actions.length)
        .map((i) => actions[i].id);

      return {
        id: uuidv4(),
        description: parsed.description ?? '',
        derivedFrom,
        parameters: resolvedParams,
        actions,
        assertions,
        navigationPlan,
        breakpoints,
      };
    } catch {
      return this.createEmptyPlan('Failed to parse LLM response', options);
    }
  }

  private applyModifications(
    recording: Recording,
    response: LLMResponse,
    options?: ExecutionOptions,
  ): ExecutionPlan {
    try {
      const parsed = JSON.parse(response.content);
      const paramOverrides: Record<string, string> = {
        ...(parsed.parameterOverrides ?? {}),
        ...(options?.parameters ?? {}),
      };
      const skipIndices = new Set<number>(parsed.skipActionIndices ?? []);
      const breakpointIndices: number[] = parsed.breakpointActionIndices ?? [];

      const allParams = new Map<string, ParameterDef>();
      for (const param of recording.parameters) {
        allParams.set(param.name, param);
      }

      const actions: ResolvedAction[] = [];
      let order = 0;

      for (let i = 0; i < recording.actions.length; i++) {
        if (skipIndices.has(i)) continue;

        const action = recording.actions[i];
        let resolvedValue = action.value;
        if (resolvedValue) {
          resolvedValue = this.resolveTemplate(resolvedValue, paramOverrides, allParams);
        }

        actions.push({
          id: `${recording.id}-action-${i}`,
          order: order++,
          type: action.type,
          selectors: action.selectors ?? { selectors: [], totalTimeout: 15000 },
          value: resolvedValue,
          description: action.description,
          page: { url: action.url, fingerprint: '' },
          timeout: 30000,
          sourceRecordingId: recording.id,
        });
      }

      // Original assertions
      const assertions: ResolvedAssertion[] = recording.assertions.map((a) => ({
        afterActionId: a.afterActionId,
        type: a.type,
        selectors: a.selectors,
        expected: a.expected,
        timeout: 10000,
        description: a.description,
      }));

      // Apply modified assertions
      const modifiedAssertions: Array<{ afterActionIndex: number; type: string; expected: string; description: string }> =
        parsed.modifiedAssertions ?? [];
      for (const mod of modifiedAssertions) {
        assertions.push({
          afterActionId: `${recording.id}-action-${mod.afterActionIndex}`,
          type: (mod.type as ResolvedAssertion['type']) ?? 'element_visible',
          expected: mod.expected,
          timeout: 10000,
          description: mod.description ?? '',
        });
      }

      const resolvedParams: Record<string, string> = {};
      for (const [name, def] of allParams) {
        resolvedParams[name] = paramOverrides[name] ?? options?.parameters?.[name] ?? def.defaultValue;
      }

      const breakpoints = (breakpointIndices as number[])
        .filter((i) => i < actions.length)
        .map((i) => actions[i].id);

      return {
        id: uuidv4(),
        description: parsed.description ?? recording.description,
        derivedFrom: [recording.id],
        parameters: resolvedParams,
        actions,
        assertions,
        navigationPlan: this.buildNavigationPlan(actions, options?.startUrl),
        breakpoints,
      };
    } catch {
      // Fallback: return unmodified recording as plan
      return this.recordingToPlan(recording, options);
    }
  }

  private recordingToPlan(recording: Recording, options?: ExecutionOptions): ExecutionPlan {
    const resolvedParams: Record<string, string> = {};
    for (const param of recording.parameters) {
      resolvedParams[param.name] = options?.parameters?.[param.name] ?? param.defaultValue;
    }

    return {
      id: uuidv4(),
      description: recording.description,
      derivedFrom: [recording.id],
      parameters: resolvedParams,
      actions: recording.actions.map((a, i) => ({
        id: `${recording.id}-action-${i}`,
        order: i,
        type: a.type,
        selectors: a.selectors ?? { selectors: [], totalTimeout: 15000 },
        value: a.value ? this.resolveTemplate(a.value, resolvedParams, new Map(recording.parameters.map((p) => [p.name, p]))) : undefined,
        description: a.description,
        page: { url: a.url, fingerprint: '' },
        timeout: 30000,
        sourceRecordingId: recording.id,
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
  }

  private createEmptyPlan(description: string, options?: ExecutionOptions): ExecutionPlan {
    return {
      id: uuidv4(),
      description,
      derivedFrom: [],
      parameters: options?.parameters ?? {},
      actions: [],
      assertions: [],
      navigationPlan: [],
      breakpoints: [],
    };
  }

  private resolveTemplate(
    template: string,
    overrides: Record<string, string>,
    params: Map<string, ParameterDef>,
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (overrides[name] !== undefined) return overrides[name];
      const def = params.get(name);
      return def?.defaultValue ?? `{{${name}}}`;
    });
  }

  private buildNavigationPlan(actions: ResolvedAction[], startUrl?: string): NavigationStep[] {
    const steps: NavigationStep[] = [];
    let currentUrl = startUrl ?? '';

    for (const action of actions) {
      if (action.page.url && action.page.url !== currentUrl) {
        // Check if sitemap has a path
        if (currentUrl) {
          const path = this.context.sitemap.findPath(currentUrl, action.page.url);
          if (path.length > 0) {
            for (const edge of path) {
              steps.push({ from: edge.from, to: edge.to, action: edge.action });
            }
          } else {
            steps.push({ from: currentUrl, to: action.page.url, action: `navigate to ${action.page.url}` });
          }
        }
        currentUrl = action.page.url;
      }
    }

    return steps;
  }

  private buildSitemapSummary(): string {
    const sitemap = this.context.sitemap.getSiteMap();
    const pages: string[] = [];
    for (const [url, page] of sitemap.pages) {
      pages.push(`- ${url}: ${page.pageType ?? 'unknown'} — ${page.title}`);
    }
    return pages.slice(0, 30).join('\n') || '(no pages)';
  }
}
