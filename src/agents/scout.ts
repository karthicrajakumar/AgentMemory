import { BaseAgent, type AgentContext, type AgentBudget } from './types.js';
import type { SiteMapPage, SiteMapEdge } from '../state/sitemap.js';
import type { LinkElement, FormField, InteractiveElement } from '../types/index.js';
import type { LLMResponse } from '../llm/interface.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface ScoutOptions {
  maxPages?: number;
  maxDepth?: number;
  stayWithinDomain?: boolean;
  excludePatterns?: string[];
  includePatterns?: string[];
  timeout?: number;
  delayBetweenPages?: number;
  screenshotDir?: string;
  signal?: AbortSignal;
}

export interface ScoutPageResult {
  url: string;
  title: string;
  fingerprint: string;
  linksFound: LinkElement[];
  formsFound: FormField[];
  interactiveElements: InteractiveElement[];
  isAuthGated: boolean;
  authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  pageType: string;
  description: string;
  screenshotPath: string;
}

const DEFAULT_SCOUT_OPTIONS: Required<Omit<ScoutOptions, 'signal'>> = {
  maxPages: 50,
  maxDepth: 5,
  stayWithinDomain: true,
  excludePatterns: [],
  includePatterns: [],
  timeout: 300_000,
  delayBetweenPages: 500,
  screenshotDir: '.replaybot/screenshots',
};

export class ScoutAgent extends BaseAgent {
  name = 'scout';
  role = 'Fast breadth-first page discovery';

  private visitedUrls = new Set<string>();
  private visitedFingerprints = new Set<string>();
  private frontier: Array<{ url: string; depth: number }> = [];
  private entryDomain = '';

  constructor(context: AgentContext, budget?: AgentBudget) {
    super(context, budget ?? { maxTokens: 50_000, maxTimeMs: 300_000 });
  }

  async scoutApp(entryUrl: string, options?: ScoutOptions): Promise<void> {
    const opts = { ...DEFAULT_SCOUT_OPTIONS, ...options };
    const startTime = Date.now();

    this.entryDomain = new URL(entryUrl).hostname;
    this.frontier = [{ url: entryUrl, depth: 0 }];
    this.visitedUrls.clear();
    this.visitedFingerprints.clear();

    while (this.frontier.length > 0) {
      this.checkAborted(opts.signal);

      // Check limits
      if (this.visitedUrls.size >= opts.maxPages) break;
      if (Date.now() - startTime > opts.timeout) break;

      const next = this.frontier.shift()!;
      if (this.visitedUrls.has(next.url)) continue;
      if (next.depth > opts.maxDepth) continue;

      try {
        const result = await this.scoutPage(next.url, opts);

        // Add to sitemap
        const sitemapPage: SiteMapPage = {
          url: result.url,
          title: result.title,
          fingerprint: result.fingerprint,
          pageType: result.pageType,
          description: result.description,
          isAuthGated: result.isAuthGated,
          authType: result.authType,
          interactiveElements: result.interactiveElements,
          forms: result.formsFound,
          links: result.linksFound,
          screenshotPath: result.screenshotPath,
          lastVisited: new Date().toISOString(),
          depth: next.depth,
        };

        this.context.sitemap.addPage(sitemapPage);

        // Add edges and expand frontier
        for (const link of result.linksFound) {
          const resolvedUrl = this.resolveUrl(link.href, next.url);
          if (!resolvedUrl) continue;
          if (!this.shouldVisit(resolvedUrl, opts)) continue;

          this.context.sitemap.addEdge({
            from: next.url,
            to: resolvedUrl,
            action: `click link "${link.text.slice(0, 50)}"`,
            selector: link.selector,
          });

          if (!this.visitedUrls.has(resolvedUrl)) {
            this.frontier.push({ url: resolvedUrl, depth: next.depth + 1 });
          }
        }

        // Delay between pages
        if (opts.delayBetweenPages > 0 && this.frontier.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayBetweenPages));
        }
      } catch (err) {
        console.warn(`[scout] Failed to scout ${next.url}:`, err);
        // Skip this page and continue
      }
    }
  }

  async scoutPage(url: string, options?: ScoutOptions): Promise<ScoutPageResult> {
    const opts = { ...DEFAULT_SCOUT_OPTIONS, ...options };

    // Navigate to the page
    await this.context.browser.navigateTo(url);
    await this.context.browser.waitForNavigation().catch(() => {});

    const page = this.context.browser.currentPage();
    const actualUrl = page.url();

    // Mark as visited
    this.visitedUrls.add(url);
    this.visitedUrls.add(actualUrl); // Also mark redirected URL

    // Observe page
    const observation = await this.context.observer.observe(page);

    // Check fingerprint dedup
    if (this.visitedFingerprints.has(observation.fingerprint)) {
      return {
        url: actualUrl,
        title: observation.title,
        fingerprint: observation.fingerprint,
        linksFound: [],
        formsFound: [],
        interactiveElements: [],
        isAuthGated: false,
        pageType: 'duplicate',
        description: 'Duplicate page (same fingerprint as previously visited page)',
        screenshotPath: '',
      };
    }
    this.visitedFingerprints.add(observation.fingerprint);

    // Save screenshot
    let screenshotPath = '';
    if (opts.screenshotDir) {
      try {
        const safeName = actualUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 100);
        screenshotPath = `${opts.screenshotDir}/${safeName}.png`;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, observation.screenshot);
      } catch {
        // Non-critical
      }
    }

    // Use LLM to classify page
    const classification = await this.classifyPage(observation);

    // Update page state
    this.context.pageState.setCurrentPage({
      url: actualUrl,
      title: observation.title,
      fingerprint: observation.fingerprint,
    });

    return {
      url: actualUrl,
      title: observation.title,
      fingerprint: observation.fingerprint,
      linksFound: observation.links,
      formsFound: observation.forms,
      interactiveElements: observation.interactiveElements,
      isAuthGated: classification.isAuthGated,
      authType: classification.authType,
      pageType: classification.pageType,
      description: classification.description,
      screenshotPath,
    };
  }

  async expandFrontier(): Promise<ScoutPageResult[]> {
    const results: ScoutPageResult[] = [];
    const batch = this.frontier.splice(0, 5); // Process up to 5 at a time

    for (const item of batch) {
      if (this.visitedUrls.has(item.url)) continue;
      try {
        const result = await this.scoutPage(item.url);
        results.push(result);
      } catch {
        // Skip failed pages
      }
    }

    return results;
  }

  getVisitedCount(): number {
    return this.visitedUrls.size;
  }

  getFrontierSize(): number {
    return this.frontier.length;
  }

  private async classifyPage(observation: {
    url: string;
    title: string;
    simplifiedDOM: string;
    forms: FormField[];
    links: LinkElement[];
    interactiveElements: InteractiveElement[];
  }): Promise<{
    pageType: string;
    description: string;
    isAuthGated: boolean;
    authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  }> {
    const formSummary = observation.forms
      .map((f) => `${f.tag}[name=${f.name}, type=${f.type}]`)
      .join(', ');

    const prompt = `Classify this web page. Respond with JSON only, no markdown.

URL: ${observation.url}
Title: ${observation.title}
Forms: ${formSummary || 'none'}
Interactive elements: ${observation.interactiveElements.length}
Links: ${observation.links.length}

DOM (simplified):
${observation.simplifiedDOM.slice(0, 2000)}

Respond with this exact JSON structure:
{
  "pageType": "<one of: login, register, form, listing, detail, dashboard, settings, search, landing, error, other>",
  "description": "<one sentence describing the page purpose>",
  "isAuthGated": <true if this page requires login/authentication to access>,
  "authType": "<if auth gated: login_form, oauth_redirect, basic_auth, or unknown; null if not auth gated>"
}`;

    try {
      const response = await this.context.llm.complete({
        systemPrompt: 'You are a web page classifier. Respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        modelTier: 'fast',
        agentId: this.name,
        temperature: 0,
        maxTokens: 200,
      });

      return this.parseClassification(response);
    } catch {
      // Fallback: heuristic classification
      return this.heuristicClassification(observation);
    }
  }

  private parseClassification(response: LLMResponse): {
    pageType: string;
    description: string;
    isAuthGated: boolean;
    authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  } {
    try {
      const parsed = JSON.parse(response.content);
      return {
        pageType: parsed.pageType ?? 'other',
        description: parsed.description ?? '',
        isAuthGated: parsed.isAuthGated ?? false,
        authType: parsed.authType ?? undefined,
      };
    } catch {
      return {
        pageType: 'other',
        description: '',
        isAuthGated: false,
      };
    }
  }

  private heuristicClassification(observation: {
    url: string;
    title: string;
    forms: FormField[];
    interactiveElements: InteractiveElement[];
  }): {
    pageType: string;
    description: string;
    isAuthGated: boolean;
    authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  } {
    const url = observation.url.toLowerCase();
    const title = observation.title.toLowerCase();
    const hasPasswordField = observation.forms.some((f) => f.type === 'password');
    const hasEmailField = observation.forms.some(
      (f) => f.type === 'email' || f.name?.includes('email'),
    );

    if (hasPasswordField && hasEmailField) {
      return {
        pageType: 'login',
        description: 'Login page with email and password fields',
        isAuthGated: false, // The login page itself isn't gated
        authType: 'login_form',
      };
    }

    if (url.includes('login') || url.includes('signin') || title.includes('sign in')) {
      return {
        pageType: 'login',
        description: 'Login page',
        isAuthGated: false,
        authType: 'login_form',
      };
    }

    if (url.includes('register') || url.includes('signup') || title.includes('sign up')) {
      return {
        pageType: 'register',
        description: 'Registration page',
        isAuthGated: false,
      };
    }

    if (observation.forms.length > 0) {
      return {
        pageType: 'form',
        description: `Page with ${observation.forms.length} form(s)`,
        isAuthGated: false,
      };
    }

    return {
      pageType: 'other',
      description: observation.title || 'Unknown page',
      isAuthGated: false,
    };
  }

  private shouldVisit(url: string, opts: Required<Omit<ScoutOptions, 'signal'>>): boolean {
    // Skip already visited
    if (this.visitedUrls.has(url)) return false;

    // Domain check
    if (opts.stayWithinDomain) {
      try {
        const urlDomain = new URL(url).hostname;
        if (urlDomain !== this.entryDomain) return false;
      } catch {
        return false;
      }
    }

    // Exclude patterns
    for (const pattern of opts.excludePatterns) {
      if (this.matchPattern(url, pattern)) return false;
    }

    // Include patterns (if any specified, URL must match at least one)
    if (opts.includePatterns.length > 0) {
      const matches = opts.includePatterns.some((p) => this.matchPattern(url, p));
      if (!matches) return false;
    }

    // Skip common non-page URLs
    const skipExtensions = ['.pdf', '.zip', '.png', '.jpg', '.gif', '.css', '.js', '.svg'];
    if (skipExtensions.some((ext) => url.toLowerCase().endsWith(ext))) return false;

    // Skip fragment-only links and javascript: URIs
    if (url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:')) {
      return false;
    }

    return true;
  }

  private matchPattern(url: string, pattern: string): boolean {
    // Simple glob matching: * matches any characters
    const regex = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return regex.test(url);
  }

  private resolveUrl(href: string, baseUrl: string): string | null {
    try {
      const resolved = new URL(href, baseUrl);
      // Remove fragment
      resolved.hash = '';
      return resolved.href;
    } catch {
      return null;
    }
  }
}
