import { ScoutAgent, type ScoutOptions, type ScoutPageResult } from './scout.js';
import { DeepExplorerAgent, type DeepExploreOptions, type DeepExploreResult } from './deep-explorer.js';
import type { AgentContext, Credentials } from './types.js';
import type { SiteMap } from '../state/sitemap.js';

export interface ExploreAppOptions {
  /** Entry URL to start exploration */
  entryUrl: string;

  /** Credentials for auto-login */
  credentials?: Credentials;

  /** Scout options (page limits, depth, patterns, etc.) */
  scout?: ScoutOptions;

  /** Deep Explorer options (verify, max interactions, etc.) */
  deepExplore?: DeepExploreOptions;

  /** Which pages to deep-explore. Default: 'forms-and-interactive' */
  deepExploreStrategy?: 'all' | 'forms-and-interactive' | 'forms-only' | 'none';

  /** Max pages to deep-explore. Default: 20 */
  maxDeepExplorePages?: number;

  /** Overall abort signal */
  signal?: AbortSignal;

  /** Called after each page is scouted */
  onPageScouted?: (result: ScoutPageResult) => void;

  /** Called after each page is deep-explored */
  onPageExplored?: (result: DeepExploreResult) => void;

  /** Called with status updates */
  onStatus?: (message: string) => void;
}

export interface ExploreAppResult {
  sitemap: SiteMap;
  scoutedPages: number;
  deepExploredPages: number;
  totalTime: number;
  authLoginPerformed: boolean;
  errors: Array<{ url: string; phase: 'scout' | 'deep-explore'; error: string }>;
}

export class Orchestrator {
  private context: AgentContext;

  constructor(context: AgentContext) {
    this.context = context;
  }

  /**
   * Full exploration flow: Scout → select pages → Deep Explore.
   * Returns the complete sitemap with deep analysis where applicable.
   */
  async exploreApp(options: ExploreAppOptions): Promise<ExploreAppResult> {
    const startTime = Date.now();
    const errors: ExploreAppResult['errors'] = [];
    const strategy = options.deepExploreStrategy ?? 'forms-and-interactive';
    const maxDeepPages = options.maxDeepExplorePages ?? 20;

    // Apply credentials to context
    if (options.credentials) {
      this.context.credentials = options.credentials;
    }

    const status = (msg: string) => {
      console.log(`[orchestrator] ${msg}`);
      options.onStatus?.(msg);
    };

    // ── Phase 1: Scout ──────────────────────────────────────────────

    status('Starting Scout phase...');

    const scout = new ScoutAgent(this.context);
    const scoutOptions: ScoutOptions = {
      ...options.scout,
      signal: options.signal,
    };

    try {
      await scout.scoutApp(options.entryUrl, scoutOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Scout may have partially completed — continue with what we have
      status(`Scout phase ended early: ${msg}`);
      errors.push({ url: options.entryUrl, phase: 'scout', error: msg });
    }

    const scoutedPages = this.context.sitemap.getPageCount();
    status(`Scout phase complete. ${scoutedPages} pages discovered.`);

    // ── Phase 2: Select pages for deep exploration ──────────────────

    if (strategy === 'none') {
      return {
        sitemap: this.context.sitemap.getSiteMap(),
        scoutedPages,
        deepExploredPages: 0,
        totalTime: Date.now() - startTime,
        authLoginPerformed: !!options.credentials,
        errors,
      };
    }

    const pagesToExplore = this.selectPagesForDeepExploration(strategy, maxDeepPages);
    status(`Selected ${pagesToExplore.length} pages for deep exploration.`);

    // ── Phase 3: Deep Explore ───────────────────────────────────────

    const deepExplorer = new DeepExplorerAgent(this.context);
    let deepExploredCount = 0;

    for (const pageUrl of pagesToExplore) {
      if (options.signal?.aborted) break;

      status(`Deep exploring: ${pageUrl}`);

      try {
        const result = await deepExplorer.explorePage(pageUrl, {
          ...options.deepExplore,
          signal: options.signal,
        });

        deepExploredCount++;
        options.onPageExplored?.(result);
        status(`Deep explored ${pageUrl}: ${result.analysis.interactionMap.length} interactions mapped, ${result.verified.length} verified`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status(`Deep explore failed for ${pageUrl}: ${msg}`);
        errors.push({ url: pageUrl, phase: 'deep-explore', error: msg });
      }
    }

    // ── Done ────────────────────────────────────────────────────────

    const totalTime = Date.now() - startTime;
    status(`Exploration complete. ${scoutedPages} scouted, ${deepExploredCount} deep-explored in ${Math.round(totalTime / 1000)}s.`);

    // Persist final state
    await this.context.sitemap.save();
    await this.context.pageState.save();

    return {
      sitemap: this.context.sitemap.getSiteMap(),
      scoutedPages,
      deepExploredPages: deepExploredCount,
      totalTime,
      authLoginPerformed: !!options.credentials,
      errors,
    };
  }

  /**
   * Resume a previous exploration — load persisted state and continue
   * exploring unvisited pages from the frontier.
   */
  async resumeExploration(options: ExploreAppOptions): Promise<ExploreAppResult> {
    const status = (msg: string) => {
      console.log(`[orchestrator] ${msg}`);
      options.onStatus?.(msg);
    };

    // Load persisted state
    await this.context.sitemap.load();
    await this.context.pageState.load();

    const existingPages = this.context.sitemap.getPageCount();
    status(`Resuming exploration. ${existingPages} pages already in sitemap.`);

    // Continue with normal exploration — Scout will skip already-visited pages
    return this.exploreApp(options);
  }

  /**
   * Select which pages should get deep analysis based on strategy.
   */
  private selectPagesForDeepExploration(
    strategy: 'all' | 'forms-and-interactive' | 'forms-only',
    maxPages: number,
  ): string[] {
    const sitemap = this.context.sitemap.getSiteMap();
    const candidates: Array<{ url: string; priority: number }> = [];

    for (const [url, page] of sitemap.pages) {
      // Skip pages that already have deep analysis
      if (page.deepAnalysis) continue;

      // Skip duplicate pages
      if (page.pageType === 'duplicate') continue;

      // Skip auth-gated pages (can't access without credentials)
      // Note: login pages themselves should be explored
      if (page.isAuthGated && page.pageType !== 'login') continue;

      let priority = 0;

      switch (strategy) {
        case 'all':
          priority = 1;
          break;

        case 'forms-and-interactive':
          if (page.forms.length > 0) priority += 3;
          if (page.interactiveElements.length > 5) priority += 2;
          if (page.pageType === 'form' || page.pageType === 'settings') priority += 2;
          if (page.pageType === 'dashboard') priority += 1;
          if (page.pageType === 'search') priority += 1;
          if (priority === 0) priority = 0.5; // Still include, but low priority
          break;

        case 'forms-only':
          if (page.forms.length > 0) priority = page.forms.length;
          break;
      }

      if (priority > 0) {
        candidates.push({ url, priority });
      }
    }

    // Sort by priority (highest first), then take top N
    return candidates
      .sort((a, b) => b.priority - a.priority)
      .slice(0, maxPages)
      .map((c) => c.url);
  }
}
