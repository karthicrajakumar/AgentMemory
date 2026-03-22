import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright';

export interface LaunchOptions {
  headless?: boolean;
  browserType?: 'chromium' | 'firefox' | 'webkit';
  poolSize?: number;
  viewport?: { width: number; height: number };
  storageStatePath?: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _pages: Page[] = [];
  private activePageIndex = 0;
  private browserTypeName: 'chromium' | 'firefox' | 'webkit' = 'chromium';
  private viewport = DEFAULT_VIEWPORT;
  private headless = false; // headed by default
  private storageStatePath?: string;

  // Pool
  private pool: BrowserContext[] = [];
  private poolInUse = new Set<BrowserContext>();
  private _poolSize = 1;

  private newPageHandlers: Array<(page: Page) => void> = [];

  // Lifecycle

  async launch(options?: LaunchOptions): Promise<void> {
    if (options?.browserType) this.browserTypeName = options.browserType;
    if (options?.headless !== undefined) this.headless = options.headless;
    if (options?.viewport) this.viewport = options.viewport;
    if (options?.storageStatePath) this.storageStatePath = options.storageStatePath;
    if (options?.poolSize) this._poolSize = options.poolSize;

    const browserType = this.getBrowserType();
    this.browser = await browserType.launch({ headless: this.headless });

    this.context = await this.browser.newContext({
      viewport: this.viewport,
      storageState: this.storageStatePath,
    });

    // Listen for new pages (popups, new tabs)
    this.context.on('page', (page) => {
      this._pages.push(page);
      for (const handler of this.newPageHandlers) {
        handler(page);
      }
    });

    const page = await this.context.newPage();
    this._pages = [page];
    this.activePageIndex = 0;

    // Pre-warm pool
    for (let i = 0; i < this._poolSize - 1; i++) {
      const ctx = await this.browser.newContext({ viewport: this.viewport });
      this.pool.push(ctx);
    }
  }

  async close(): Promise<void> {
    for (const ctx of this.pool) {
      await ctx.close();
    }
    this.pool = [];
    this.poolInUse.clear();

    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this._pages = [];
    this.activePageIndex = 0;
  }

  // Page management

  currentPage(): Page {
    this.ensureLaunched();
    return this._pages[this.activePageIndex];
  }

  pages(): Page[] {
    return [...this._pages];
  }

  async createPage(): Promise<Page> {
    this.ensureLaunched();
    const page = await this.context!.newPage();
    // Note: page is automatically added to _pages via the context 'page' event handler
    return page;
  }

  switchToPage(index: number): void {
    if (index < 0 || index >= this._pages.length) {
      throw new Error(`Page index ${index} out of range (0-${this._pages.length - 1})`);
    }
    this.activePageIndex = index;
  }

  onNewPage(handler: (page: Page) => void): void {
    this.newPageHandlers.push(handler);
  }

  async navigateTo(url: string): Promise<void> {
    this.ensureLaunched();
    await this.currentPage().goto(url, { waitUntil: 'domcontentloaded' });
  }

  async waitForNavigation(timeout = 30000): Promise<void> {
    this.ensureLaunched();
    await this.currentPage().waitForLoadState('domcontentloaded', { timeout });
  }

  // Browser pool

  async acquireContext(): Promise<BrowserContext> {
    this.ensureLaunched();

    // Try to get a free context from the pool
    const free = this.pool.find((ctx) => !this.poolInUse.has(ctx));
    if (free) {
      this.poolInUse.add(free);
      return free;
    }

    // Create a new one if under pool size
    if (this.pool.length < this._poolSize) {
      const ctx = await this.browser!.newContext({ viewport: this.viewport });
      this.pool.push(ctx);
      this.poolInUse.add(ctx);
      return ctx;
    }

    throw new Error('No available browser contexts in pool. Increase poolSize or release a context.');
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    this.poolInUse.delete(context);
  }

  poolSize(): number {
    return this._poolSize;
  }

  setPoolSize(size: number): void {
    this._poolSize = Math.max(1, size);
  }

  // Auth state

  async saveStorageState(path: string): Promise<void> {
    this.ensureLaunched();
    await this.context!.storageState({ path });
  }

  async loadStorageState(path: string): Promise<void> {
    this.storageStatePath = path;
    // If browser is running, recreate context with new storage state
    if (this.browser && this.context) {
      const oldContext = this.context;
      this.context = await this.browser.newContext({
        viewport: this.viewport,
        storageState: path,
      });
      const page = await this.context.newPage();
      this._pages = [page];
      this.activePageIndex = 0;
      await oldContext.close();
    }
  }

  // Configuration

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    if (this._pages.length > 0) {
      await this.currentPage().setViewportSize(this.viewport);
    }
  }

  setBrowserType(type: 'chromium' | 'firefox' | 'webkit'): void {
    if (this.browser) {
      throw new Error('Cannot change browser type while browser is running. Close first.');
    }
    this.browserTypeName = type;
  }

  // Internal

  private getBrowserType(): BrowserType {
    switch (this.browserTypeName) {
      case 'firefox':
        return firefox;
      case 'webkit':
        return webkit;
      default:
        return chromium;
    }
  }

  private ensureLaunched(): void {
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched. Call launch() first.');
    }
  }
}
