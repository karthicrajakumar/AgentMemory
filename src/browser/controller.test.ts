import { describe, it, expect, afterEach } from 'vitest';
import { BrowserController } from './controller.js';

describe('BrowserController', () => {
  let controller: BrowserController;

  afterEach(async () => {
    if (controller) {
      await controller.close();
    }
  });

  it('throws when accessing page before launch', () => {
    controller = new BrowserController();
    expect(() => controller.currentPage()).toThrow('Browser not launched');
  });

  it('launches and provides a page', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });

    const page = controller.currentPage();
    expect(page).toBeTruthy();
    expect(controller.pages()).toHaveLength(1);
  }, 15000);

  it('navigates to a URL', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });

    await controller.navigateTo('data:text/html,<h1>Hello</h1>');
    const page = controller.currentPage();
    const title = await page.evaluate(() => document.querySelector('h1')?.textContent);
    expect(title).toBe('Hello');
  }, 15000);

  it('supports multiple pages', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });

    const page2 = await controller.createPage();
    expect(controller.pages()).toHaveLength(2);

    await page2.goto('data:text/html,<h1>Page 2</h1>');
    controller.switchToPage(1);
    expect(controller.currentPage()).toBe(page2);
  }, 15000);

  it('throws on invalid page index', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });

    expect(() => controller.switchToPage(5)).toThrow('out of range');
  }, 15000);

  it('manages browser pool', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true, poolSize: 2 });

    const ctx1 = await controller.acquireContext();
    expect(ctx1).toBeTruthy();

    await controller.releaseContext(ctx1);
  }, 15000);

  it('throws when pool is exhausted', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true, poolSize: 1 });

    // The pool has 0 extra contexts (poolSize 1 means just the main context)
    // Actually the pool pre-warms poolSize-1 = 0 contexts
    // acquireContext creates new ones up to poolSize
    const ctx = await controller.acquireContext();
    await expect(controller.acquireContext()).rejects.toThrow('No available browser contexts');
    await controller.releaseContext(ctx);
  }, 15000);

  it('closes cleanly', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });
    await controller.close();

    expect(() => controller.currentPage()).toThrow('Browser not launched');
  }, 15000);

  it('sets viewport', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true, viewport: { width: 800, height: 600 } });

    const page = controller.currentPage();
    const size = page.viewportSize();
    expect(size?.width).toBe(800);
    expect(size?.height).toBe(600);

    await controller.setViewport(1920, 1080);
    const newSize = page.viewportSize();
    expect(newSize?.width).toBe(1920);
  }, 15000);

  it('prevents changing browser type while running', async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });

    expect(() => controller.setBrowserType('firefox')).toThrow('Cannot change browser type');
  }, 15000);
});
