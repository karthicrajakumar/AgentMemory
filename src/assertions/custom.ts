import { type Page } from 'playwright';
import type { LLMClient } from '../llm/interface.js';
import type { AssertionResult } from '../state/recordings.js';

export type CustomAssertionFn = (
  page: Page,
  params: Record<string, unknown>,
) => Promise<AssertionResult>;

/**
 * Custom assertion engine: LLM-generated assertions from natural language,
 * plus a registry for reusable custom assertion functions.
 */
export class CustomAssertionEngine {
  private registry = new Map<string, CustomAssertionFn>();
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Convert a natural language description into an assertion and execute it.
   * Uses LLM to generate the check, then evaluates it in the page context.
   *
   * Example: "the shopping cart should show 3 items"
   */
  async fromDescription(
    page: Page,
    description: string,
  ): Promise<AssertionResult> {
    const start = Date.now();

    try {
      // Ask LLM to generate a JavaScript assertion expression
      const response = await this.llm.complete({
        systemPrompt: `You are a test assertion generator. Given a page context and a natural language assertion description, generate a JavaScript function body that can be evaluated in a browser page context.

The function receives the document and should return { pass: boolean, actual: string }.

Respond with ONLY the JavaScript code, no markdown, no explanation. The code must be a function body (not a function declaration) that returns an object with "pass" (boolean) and "actual" (string).

Example input: "the page should have exactly 3 list items"
Example output:
const items = document.querySelectorAll('li');
return { pass: items.length === 3, actual: String(items.length) + ' list items found' };`,
        messages: [
          {
            role: 'user',
            content: `Page URL: ${page.url()}
Page title: ${await page.title()}

Assertion: "${description}"

Generate the JavaScript function body:`,
          },
        ],
        modelTier: 'fast',
        agentId: 'custom-assertion',
        temperature: 0,
        maxTokens: 500,
      });

      // Execute the generated code in the page context
      const code = response.content.trim();
      const result = await page.evaluate((fnBody) => {
        try {
          const fn = new Function(fnBody);
          return fn() as { pass: boolean; actual: string };
        } catch (err) {
          return { pass: false, actual: `Evaluation error: ${err}` };
        }
      }, code);

      return {
        pass: result.pass,
        message: result.pass ? `Assertion passed: ${description}` : `Assertion failed: ${description}`,
        expected: description,
        actual: result.actual,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        pass: false,
        message: `LLM assertion failed: ${err instanceof Error ? err.message : String(err)}`,
        expected: description,
        duration: Date.now() - start,
      };
    }
  }

  /**
   * Register a reusable custom assertion function.
   */
  register(name: string, fn: CustomAssertionFn): void {
    this.registry.set(name, fn);
  }

  /**
   * Execute a registered custom assertion.
   */
  async run(
    name: string,
    page: Page,
    params: Record<string, unknown> = {},
  ): Promise<AssertionResult> {
    const fn = this.registry.get(name);
    if (!fn) {
      return {
        pass: false,
        message: `Custom assertion "${name}" not registered`,
        duration: 0,
      };
    }
    return fn(page, params);
  }

  /**
   * List all registered custom assertions.
   */
  listRegistered(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Check if a custom assertion is registered.
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }
}
