import { type Page } from 'playwright';
import type { SelectorChain, SelectorEntry } from '../types/index.js';
import type { AssertionResult } from '../state/recordings.js';

/**
 * Element-based assertions: visibility, text, value, URL, title, count, attributes.
 * All assertions are "soft" by default — they return results instead of throwing.
 */
export class ElementAssertionEngine {
  async assertVisible(page: Page, selectors: SelectorChain): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      await locator.waitFor({ state: 'visible', timeout: selectors.totalTimeout ?? 5000 });
      return {
        pass: true,
        message: 'Element is visible',
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Element not visible: ${err instanceof Error ? err.message : String(err)}`,
        duration: Date.now() - start,
      };
    }
  }

  async assertNotVisible(page: Page, selectors: SelectorChain): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      await locator.waitFor({ state: 'hidden', timeout: selectors.totalTimeout ?? 5000 });
      return {
        pass: true,
        message: 'Element is not visible',
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Element is still visible: ${err instanceof Error ? err.message : String(err)}`,
        duration: Date.now() - start,
      };
    }
  }

  async assertText(page: Page, selectors: SelectorChain, expected: string): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      const actual = await locator.textContent({ timeout: 5000 });
      const trimmed = actual?.trim() ?? '';

      const pass = trimmed.includes(expected);
      return {
        pass,
        message: pass ? `Text matches: "${expected}"` : `Text mismatch`,
        expected,
        actual: trimmed,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Failed to get text: ${err instanceof Error ? err.message : String(err)}`,
        expected,
        duration: Date.now() - start,
      };
    }
  }

  async assertValue(page: Page, selectors: SelectorChain, expected: string): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      const actual = await locator.inputValue({ timeout: 5000 });

      const pass = actual === expected;
      return {
        pass,
        message: pass ? `Value matches: "${expected}"` : `Value mismatch`,
        expected,
        actual,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Failed to get value: ${err instanceof Error ? err.message : String(err)}`,
        expected,
        duration: Date.now() - start,
      };
    }
  }

  async assertUrl(page: Page, pattern: string): Promise<AssertionResult> {
    const start = Date.now();
    const actual = page.url();

    let pass: boolean;
    try {
      const regex = new RegExp(pattern);
      pass = regex.test(actual);
    } catch {
      // Treat as literal substring match
      pass = actual.includes(pattern);
    }

    return {
      pass,
      message: pass ? `URL matches pattern: ${pattern}` : `URL does not match`,
      expected: pattern,
      actual,
      duration: Date.now() - start,
    };
  }

  async assertTitle(page: Page, expected: string): Promise<AssertionResult> {
    const start = Date.now();
    const actual = await page.title();

    let pass: boolean;
    try {
      const regex = new RegExp(expected);
      pass = regex.test(actual);
    } catch {
      pass = actual.includes(expected);
    }

    return {
      pass,
      message: pass ? `Title matches: "${expected}"` : `Title mismatch`,
      expected,
      actual,
      duration: Date.now() - start,
    };
  }

  async assertElementCount(page: Page, selectors: SelectorChain, count: number): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      const actual = await locator.count();

      const pass = actual === count;
      return {
        pass,
        message: pass ? `Element count is ${count}` : `Expected ${count} elements, found ${actual}`,
        expected: String(count),
        actual: String(actual),
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Failed to count elements: ${err instanceof Error ? err.message : String(err)}`,
        expected: String(count),
        duration: Date.now() - start,
      };
    }
  }

  async assertAttribute(
    page: Page,
    selectors: SelectorChain,
    attr: string,
    expected: string,
  ): Promise<AssertionResult> {
    const start = Date.now();
    try {
      const locator = this.resolveLocator(page, selectors);
      const actual = await locator.getAttribute(attr, { timeout: 5000 });

      const pass = actual === expected;
      return {
        pass,
        message: pass ? `Attribute "${attr}" matches: "${expected}"` : `Attribute "${attr}" mismatch`,
        expected,
        actual: actual ?? '(null)',
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Failed to get attribute: ${err instanceof Error ? err.message : String(err)}`,
        expected,
        duration: Date.now() - start,
      };
    }
  }

  private resolveLocator(page: Page, selectors: SelectorChain) {
    // Use first selector in chain for assertions
    const entry = selectors.selectors[0];
    if (!entry) throw new Error('No selectors in chain');
    return page.locator(toPlaywrightSelector(entry));
  }
}

function toPlaywrightSelector(entry: SelectorEntry): string {
  switch (entry.strategy) {
    case 'aria': return `role=${entry.value}`;
    case 'testid': return `[data-testid="${entry.value}"]`;
    case 'text': return `text=${entry.value}`;
    case 'css': return entry.value;
    case 'xpath': return `xpath=${entry.value}`;
    default: return entry.value;
  }
}
