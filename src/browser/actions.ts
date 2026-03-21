import { type Page, type ElementHandle } from 'playwright';
import type { SelectorChain, ActionResult, ResolvedSelector } from '../types/index.js';

const DEFAULT_SELECTOR_TIMEOUT = 5000;
const DEFAULT_TOTAL_TIMEOUT = 15000;

export class ActionExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  setPage(page: Page): void {
    this.page = page;
  }

  async click(selectors: SelectorChain): Promise<ActionResult> {
    return this.executeAction(selectors, async (resolved) => {
      const locator = this.toLocator(resolved);
      await locator.click();
    });
  }

  async type(selectors: SelectorChain, text: string): Promise<ActionResult> {
    return this.executeAction(selectors, async (resolved) => {
      const locator = this.toLocator(resolved);
      await locator.fill(text);
    });
  }

  async select(selectors: SelectorChain, value: string): Promise<ActionResult> {
    return this.executeAction(selectors, async (resolved) => {
      const locator = this.toLocator(resolved);
      await locator.selectOption(value);
    });
  }

  async hover(selectors: SelectorChain): Promise<ActionResult> {
    return this.executeAction(selectors, async (resolved) => {
      const locator = this.toLocator(resolved);
      await locator.hover();
    });
  }

  async scroll(direction: 'up' | 'down', amount = 300): Promise<ActionResult> {
    const start = Date.now();
    try {
      const delta = direction === 'down' ? amount : -amount;
      await this.page.mouse.wheel(0, delta);
      return {
        success: true,
        usedSelector: { strategy: 'native', value: `scroll-${direction}` },
        duration: Date.now() - start,
        timestamp: start,
      };
    } catch (err) {
      return {
        success: false,
        usedSelector: { strategy: 'native', value: `scroll-${direction}` },
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
        timestamp: start,
      };
    }
  }

  async navigate(url: string): Promise<ActionResult> {
    const start = Date.now();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      return {
        success: true,
        usedSelector: { strategy: 'native', value: url },
        duration: Date.now() - start,
        timestamp: start,
      };
    } catch (err) {
      return {
        success: false,
        usedSelector: { strategy: 'native', value: url },
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
        timestamp: start,
      };
    }
  }

  async resolveSelector(selectors: SelectorChain): Promise<ResolvedSelector> {
    const totalTimeout = selectors.totalTimeout ?? DEFAULT_TOTAL_TIMEOUT;
    const deadline = Date.now() + totalTimeout;

    for (const entry of selectors.selectors) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const timeout = Math.min(entry.timeout ?? DEFAULT_SELECTOR_TIMEOUT, remaining);
      const playwrightSelector = this.toPlaywrightSelector(entry.strategy, entry.value);

      try {
        const element = await this.page.waitForSelector(playwrightSelector, {
          timeout,
          state: 'visible',
        });

        if (element) {
          return {
            strategy: entry.strategy,
            value: entry.value,
            element: element as unknown,
          };
        }
      } catch {
        // Try next selector in chain
        continue;
      }
    }

    throw new Error(
      `No selector resolved within ${totalTimeout}ms. Tried: ${selectors.selectors.map((s) => `${s.strategy}="${s.value}"`).join(', ')}`,
    );
  }

  async waitForElement(selectors: SelectorChain, timeout?: number): Promise<ActionResult> {
    const start = Date.now();
    const chain = { ...selectors, totalTimeout: timeout ?? selectors.totalTimeout };
    try {
      const resolved = await this.resolveSelector(chain);
      return {
        success: true,
        usedSelector: { strategy: resolved.strategy, value: resolved.value },
        duration: Date.now() - start,
        timestamp: start,
      };
    } catch (err) {
      return {
        success: false,
        usedSelector: { strategy: 'none', value: 'none' },
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
        timestamp: start,
      };
    }
  }

  async waitForNavigation(timeout = 30000): Promise<ActionResult> {
    const start = Date.now();
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout });
      return {
        success: true,
        usedSelector: { strategy: 'native', value: 'navigation' },
        duration: Date.now() - start,
        timestamp: start,
      };
    } catch (err) {
      return {
        success: false,
        usedSelector: { strategy: 'native', value: 'navigation' },
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
        timestamp: start,
      };
    }
  }

  // Internal

  private async executeAction(
    selectors: SelectorChain,
    action: (resolved: ResolvedSelector) => Promise<void>,
  ): Promise<ActionResult> {
    const start = Date.now();
    try {
      const resolved = await this.resolveSelector(selectors);
      await action(resolved);
      return {
        success: true,
        usedSelector: { strategy: resolved.strategy, value: resolved.value },
        duration: Date.now() - start,
        timestamp: start,
      };
    } catch (err) {
      return {
        success: false,
        usedSelector: { strategy: 'none', value: 'none' },
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
        timestamp: start,
      };
    }
  }

  private toPlaywrightSelector(strategy: string, value: string): string {
    switch (strategy) {
      case 'aria':
        return `role=${value}`;
      case 'testid':
        return `[data-testid="${value}"]`;
      case 'css':
        return value;
      case 'text':
        return `text=${value}`;
      case 'xpath':
        return `xpath=${value}`;
      default:
        return value;
    }
  }

  private toLocator(resolved: ResolvedSelector) {
    const selector = this.toPlaywrightSelector(resolved.strategy, resolved.value);
    return this.page.locator(selector);
  }
}
