import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { BrowserController } from './controller.js';
import { ActionExecutor } from './actions.js';
import type { SelectorChain } from '../types/index.js';

describe('ActionExecutor', () => {
  let controller: BrowserController;
  let executor: ActionExecutor;

  const testHTML = `data:text/html,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><title>Action Test</title></head>
    <body>
      <button id="test-btn" data-testid="btn-1" onclick="document.getElementById('result').textContent='clicked'">Click Me</button>
      <input id="test-input" type="text" data-testid="input-1" />
      <select id="test-select" data-testid="select-1">
        <option value="a">Option A</option>
        <option value="b">Option B</option>
      </select>
      <div id="result"></div>
    </body>
    </html>
  `)}`;

  beforeAll(async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });
    await controller.navigateTo(testHTML);
    executor = new ActionExecutor(controller.currentPage());
  }, 15000);

  afterAll(async () => {
    await controller.close();
  });

  it('clicks an element by testid', async () => {
    const chain: SelectorChain = {
      selectors: [{ strategy: 'testid', value: 'btn-1' }],
    };

    const result = await executor.click(chain);
    expect(result.success).toBe(true);
    expect(result.usedSelector.strategy).toBe('testid');
    expect(result.duration).toBeGreaterThan(0);
    expect(result.timestamp).toBeGreaterThan(0);

    const text = await controller.currentPage().textContent('#result');
    expect(text).toBe('clicked');
  }, 10000);

  it('types text into an input', async () => {
    const chain: SelectorChain = {
      selectors: [{ strategy: 'testid', value: 'input-1' }],
    };

    const result = await executor.type(chain, 'hello world');
    expect(result.success).toBe(true);

    const value = await controller.currentPage().inputValue('#test-input');
    expect(value).toBe('hello world');
  }, 10000);

  it('selects an option from dropdown', async () => {
    const chain: SelectorChain = {
      selectors: [{ strategy: 'testid', value: 'select-1' }],
    };

    const result = await executor.select(chain, 'b');
    expect(result.success).toBe(true);

    const value = await controller.currentPage().inputValue('#test-select');
    expect(value).toBe('b');
  }, 10000);

  it('falls back through selector chain', async () => {
    const chain: SelectorChain = {
      selectors: [
        { strategy: 'testid', value: 'nonexistent', timeout: 500 },
        { strategy: 'css', value: '#test-btn' },
      ],
      totalTimeout: 5000,
    };

    const result = await executor.click(chain);
    expect(result.success).toBe(true);
    expect(result.usedSelector.strategy).toBe('css');
    expect(result.usedSelector.value).toBe('#test-btn');
  }, 10000);

  it('fails gracefully when no selector matches', async () => {
    const chain: SelectorChain = {
      selectors: [
        { strategy: 'testid', value: 'nonexistent', timeout: 500 },
      ],
      totalTimeout: 1000,
    };

    const result = await executor.click(chain);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  }, 10000);

  it('scrolls the page', async () => {
    const result = await executor.scroll('down', 200);
    expect(result.success).toBe(true);
    expect(result.usedSelector.strategy).toBe('native');
  }, 10000);

  it('navigates to URL', async () => {
    const result = await executor.navigate('data:text/html,<h1>Navigated</h1>');
    expect(result.success).toBe(true);

    const text = await controller.currentPage().textContent('h1');
    expect(text).toBe('Navigated');

    // Navigate back for other tests
    await controller.navigateTo(testHTML);
    executor.setPage(controller.currentPage());
  }, 10000);

  it('waits for an element', async () => {
    const chain: SelectorChain = {
      selectors: [{ strategy: 'css', value: '#test-btn' }],
    };

    const result = await executor.waitForElement(chain);
    expect(result.success).toBe(true);
  }, 10000);
});
