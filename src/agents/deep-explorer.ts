import { BaseAgent, type AgentContext, type AgentBudget } from './types.js';
import type {
  DeepPageAnalysis,
  InteractionMapEntry,
  FormAnalysis,
  FormFieldAnalysis,
  DynamicRegion,
  SiteMapPage,
} from '../state/sitemap.js';
import type { InteractiveElement, FormField } from '../types/index.js';
import type { LLMResponse } from '../llm/interface.js';

export interface DeepExploreOptions {
  signal?: AbortSignal;
  skipSharedComponents?: boolean; // Default: true
  verifyPredictions?: boolean; // Default: true (selective verify)
  maxInteractionsPerPage?: number; // Default: 10
}

export interface DeepExploreResult {
  url: string;
  analysis: DeepPageAnalysis;
  verified: VerificationResult[];
  skippedSharedComponents: string[];
}

export interface VerificationResult {
  elementSelector: string;
  prediction: string;
  actual: string;
  matched: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<DeepExploreOptions, 'signal'>> = {
  skipSharedComponents: true,
  verifyPredictions: true,
  maxInteractionsPerPage: 10,
};

export class DeepExplorerAgent extends BaseAgent {
  name = 'deep-explorer';
  role = 'Deep page analysis with observe + selective verify';

  constructor(context: AgentContext, budget?: AgentBudget) {
    super(context, budget ?? { maxTokens: 100_000, maxTimeMs: 600_000 });
  }

  /**
   * Deeply analyze a single page: predict interaction outcomes via LLM,
   * then selectively verify uncertain predictions by actually interacting.
   */
  async explorePage(url: string, options?: DeepExploreOptions): Promise<DeepExploreResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.startTime = Date.now();

    // Navigate to page if not already there
    const currentPage = this.context.browser.currentPage();
    if (currentPage.url() !== url) {
      await this.context.browser.navigateTo(url);
      await this.context.browser.waitForNavigation().catch(() => {});
    }

    const page = this.context.browser.currentPage();

    // Observe the page
    const observation = await this.withRetry(
      () => this.context.observer.observe(page),
      'observe page',
    );

    // Identify which elements belong to shared components (skip them)
    const skippedSharedComponents: string[] = [];
    let elementsToAnalyze = observation.interactiveElements;
    let formsToAnalyze = observation.forms;

    if (opts.skipSharedComponents) {
      const sharedComps = this.context.sitemap.getAllSharedComponents();
      for (const comp of sharedComps) {
        skippedSharedComponents.push(comp.id);
      }
      // Filter out elements that belong to shared component regions
      // We keep all elements for now — the LLM will focus on unique content
      // The shared component selectors help the LLM know what to skip
    }

    this.checkAborted(opts.signal);
    this.checkBudget();

    // Phase 1: Observe — use LLM to predict interaction outcomes
    const analysis = await this.analyzePageWithLLM(
      observation.url,
      observation.title,
      observation.simplifiedDOM,
      elementsToAnalyze,
      formsToAnalyze,
      skippedSharedComponents,
    );

    this.checkAborted(opts.signal);
    this.checkBudget();

    // Phase 2: Selective verify — actually interact with uncertain predictions
    const verified: VerificationResult[] = [];
    if (opts.verifyPredictions && analysis.interactionMap.length > 0) {
      const toVerify = this.selectForVerification(analysis.interactionMap, opts.maxInteractionsPerPage);

      for (const entry of toVerify) {
        this.checkAborted(opts.signal);
        this.checkBudget();

        try {
          const result = await this.verifyInteraction(entry, url);
          verified.push(result);

          // Update the prediction if verification showed something different
          if (!result.matched) {
            entry.expectedOutcome = result.actual;
          }
        } catch {
          // Skip failed verifications
        }
      }
    }

    // Store analysis in sitemap
    this.context.sitemap.updatePage(url, { deepAnalysis: analysis });

    return {
      url,
      analysis,
      verified,
      skippedSharedComponents,
    };
  }

  /**
   * Use LLM (Sonnet-tier) to analyze the page and predict what each interactive element does.
   */
  private async analyzePageWithLLM(
    url: string,
    title: string,
    simplifiedDOM: string,
    elements: InteractiveElement[],
    forms: FormField[],
    sharedComponentIds: string[],
  ): Promise<DeepPageAnalysis> {
    const elementSummary = elements
      .slice(0, 50) // Cap to avoid token overflow
      .map((e, i) => `${i + 1}. <${e.tag}> selector="${e.selector}" text="${e.text ?? ''}" role="${e.role ?? ''}" type="${e.type ?? ''}"`)
      .join('\n');

    const formSummary = forms
      .map((f, i) => `Form ${i + 1}: <${f.tag}> name="${f.name ?? ''}" type="${f.type}" label="${f.label ?? ''}" required=${f.required ?? false}`)
      .join('\n');

    const sharedNote = sharedComponentIds.length > 0
      ? `\nNOTE: Skip analysis of shared components (already analyzed): ${sharedComponentIds.join(', ')}`
      : '';

    const prompt = `Analyze this web page deeply. For each interactive element, predict what happens when a user interacts with it.
Respond with JSON only, no markdown.

URL: ${url}
Title: ${title}
${sharedNote}

Interactive elements:
${elementSummary || 'none'}

Form fields:
${formSummary || 'none'}

DOM (simplified, first 4000 chars):
${simplifiedDOM.slice(0, 4000)}

Respond with this exact JSON structure:
{
  "pageType": "<dashboard|listing|detail|form|settings|search|landing|error|other>",
  "purpose": "<1-2 sentence description of what this page is for>",
  "interactionMap": [
    {
      "elementSelector": "<selector of the element>",
      "elementDescription": "<what this element is>",
      "expectedOutcome": "<what happens when clicked/interacted with>",
      "confidence": "<high|medium|low>",
      "sideEffects": ["<any side effects like API calls, state changes>"],
      "stateChanges": ["<visible UI changes>"]
    }
  ],
  "formAnalyses": [
    {
      "selector": "<form selector or first field selector>",
      "purpose": "<what this form does>",
      "fields": [
        {
          "name": "<field name>",
          "type": "<field type>",
          "required": true,
          "validationRules": ["<any validation rules you can infer>"],
          "selector": "<field selector>",
          "suggestedTestValues": {
            "valid": "<a realistic valid value>",
            "invalid": ["<invalid values to test validation>"]
          }
        }
      ],
      "submitButtonSelector": "<selector for submit button>",
      "expectedSuccessIndicator": "<what appears on success>",
      "expectedErrorIndicator": "<what appears on error>"
    }
  ],
  "dynamicRegions": [
    {
      "description": "<what changes dynamically>",
      "triggerAction": "<what triggers the change>",
      "triggerSelector": "<selector that triggers it>"
    }
  ],
  "suggestedTestScenarios": [
    "<natural language test scenario descriptions>"
  ]
}`;

    try {
      const response = await this.context.llm.complete({
        systemPrompt: 'You are a web application analyst. Analyze pages and predict interaction outcomes. Respond with valid JSON only. Be specific about selectors and outcomes.',
        messages: [{ role: 'user', content: prompt }],
        modelTier: 'balanced', // Sonnet-tier for deep analysis
        agentId: this.name,
        temperature: 0,
        maxTokens: 4000,
      });

      return this.parseAnalysis(response);
    } catch (err) {
      console.warn('[deep-explorer] LLM analysis failed, returning minimal analysis:', err);
      return {
        pageType: 'other',
        purpose: `Page at ${url}`,
        interactionMap: [],
        formAnalyses: [],
        dynamicRegions: [],
        suggestedTestScenarios: [],
        analyzedAt: new Date().toISOString(),
      };
    }
  }

  private parseAnalysis(response: LLMResponse): DeepPageAnalysis {
    try {
      const parsed = JSON.parse(response.content);

      const interactionMap: InteractionMapEntry[] = (parsed.interactionMap ?? []).map(
        (entry: Record<string, unknown>) => ({
          elementSelector: String(entry.elementSelector ?? ''),
          elementDescription: String(entry.elementDescription ?? ''),
          expectedOutcome: String(entry.expectedOutcome ?? ''),
          sideEffects: Array.isArray(entry.sideEffects) ? entry.sideEffects.map(String) : [],
          stateChanges: Array.isArray(entry.stateChanges) ? entry.stateChanges.map(String) : [],
          _confidence: String((entry as Record<string, unknown>).confidence ?? 'medium'),
        }),
      );

      const formAnalyses: FormAnalysis[] = (parsed.formAnalyses ?? []).map(
        (form: Record<string, unknown>) => ({
          selector: String(form.selector ?? ''),
          purpose: String(form.purpose ?? ''),
          fields: Array.isArray(form.fields)
            ? (form.fields as Record<string, unknown>[]).map(
                (f): FormFieldAnalysis => ({
                  name: String(f.name ?? ''),
                  type: String(f.type ?? 'text'),
                  required: Boolean(f.required),
                  validationRules: Array.isArray(f.validationRules) ? f.validationRules.map(String) : [],
                  selector: String(f.selector ?? ''),
                  suggestedTestValues: {
                    valid: String((f.suggestedTestValues as Record<string, unknown>)?.valid ?? ''),
                    invalid: Array.isArray((f.suggestedTestValues as Record<string, unknown>)?.invalid)
                      ? ((f.suggestedTestValues as Record<string, unknown>).invalid as unknown[]).map(String)
                      : [],
                  },
                }),
              )
            : [],
          submitButtonSelector: String(form.submitButtonSelector ?? ''),
          expectedSuccessIndicator: String(form.expectedSuccessIndicator ?? ''),
          expectedErrorIndicator: String(form.expectedErrorIndicator ?? ''),
        }),
      );

      const dynamicRegions: DynamicRegion[] = (parsed.dynamicRegions ?? []).map(
        (region: Record<string, unknown>) => ({
          description: String(region.description ?? ''),
          triggerAction: String(region.triggerAction ?? ''),
          triggerSelector: String(region.triggerSelector ?? ''),
          resultFingerprint: '',
        }),
      );

      return {
        pageType: String(parsed.pageType ?? 'other'),
        purpose: String(parsed.purpose ?? ''),
        interactionMap,
        formAnalyses,
        dynamicRegions,
        suggestedTestScenarios: Array.isArray(parsed.suggestedTestScenarios)
          ? parsed.suggestedTestScenarios.map(String)
          : [],
        analyzedAt: new Date().toISOString(),
      };
    } catch {
      return {
        pageType: 'other',
        purpose: '',
        interactionMap: [],
        formAnalyses: [],
        dynamicRegions: [],
        suggestedTestScenarios: [],
        analyzedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Select which predictions to verify. Prioritize low/medium confidence predictions.
   */
  private selectForVerification(
    interactionMap: (InteractionMapEntry & { _confidence?: string })[],
    maxInteractions: number,
  ): InteractionMapEntry[] {
    // Sort by confidence: low first, then medium, then high
    const prioritized = [...interactionMap].sort((a, b) => {
      const order: Record<string, number> = { low: 0, medium: 1, high: 2 };
      const aConf = order[(a as { _confidence?: string })._confidence ?? 'medium'] ?? 1;
      const bConf = order[(b as { _confidence?: string })._confidence ?? 'medium'] ?? 1;
      return aConf - bConf;
    });

    // Only verify low/medium confidence predictions
    return prioritized
      .filter((entry) => {
        const conf = (entry as { _confidence?: string })._confidence ?? 'medium';
        return conf !== 'high';
      })
      .slice(0, maxInteractions);
  }

  /**
   * Actually click/interact with an element and observe what happens,
   * then navigate back to the original page.
   */
  private async verifyInteraction(
    entry: InteractionMapEntry,
    originalUrl: string,
  ): Promise<VerificationResult> {
    const page = this.context.browser.currentPage();
    const beforeUrl = page.url();

    try {
      // Take a snapshot before interaction
      const beforeFingerprint = await this.context.observer.getPageFingerprint(page);

      // Click the element
      await page.locator(entry.elementSelector).click({ timeout: 5000 });

      // Wait for any response
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const afterUrl = page.url();
      const afterFingerprint = await this.context.observer.getPageFingerprint(page);

      // Determine what actually happened
      let actual: string;
      if (afterUrl !== beforeUrl) {
        actual = `Navigated to ${afterUrl}`;
      } else if (afterFingerprint !== beforeFingerprint) {
        actual = 'Page content changed (DOM updated)';
      } else {
        actual = 'No visible change';
      }

      // Navigate back if we left the page
      if (afterUrl !== originalUrl) {
        await this.context.browser.navigateTo(originalUrl);
        await this.context.browser.waitForNavigation().catch(() => {});
      }

      // Simple match: check if prediction roughly matches actual
      const matched = this.predictionMatches(entry.expectedOutcome, actual, afterUrl);

      return {
        elementSelector: entry.elementSelector,
        prediction: entry.expectedOutcome,
        actual,
        matched,
      };
    } catch (err) {
      // Navigate back on failure
      if (page.url() !== originalUrl) {
        await this.context.browser.navigateTo(originalUrl).catch(() => {});
      }

      return {
        elementSelector: entry.elementSelector,
        prediction: entry.expectedOutcome,
        actual: `Verification failed: ${err instanceof Error ? err.message : String(err)}`,
        matched: false,
      };
    }
  }

  /**
   * Check if a prediction roughly matches what actually happened.
   */
  private predictionMatches(prediction: string, actual: string, afterUrl: string): boolean {
    const predLower = prediction.toLowerCase();
    const actualLower = actual.toLowerCase();

    // If prediction mentions navigation and we did navigate
    if (
      (predLower.includes('navigate') || predLower.includes('redirect') || predLower.includes('go to') || predLower.includes('opens')) &&
      actualLower.includes('navigated')
    ) {
      return true;
    }

    // If prediction mentions a change and DOM changed
    if (
      (predLower.includes('show') || predLower.includes('display') || predLower.includes('open') || predLower.includes('toggle') || predLower.includes('expand')) &&
      actualLower.includes('changed')
    ) {
      return true;
    }

    // If both say nothing happened
    if (
      (predLower.includes('no ') || predLower.includes('nothing')) &&
      actualLower.includes('no visible')
    ) {
      return true;
    }

    return false;
  }
}
