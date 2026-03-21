import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { BrowserController } from './controller.js';
import { PageObserver } from './observer.js';

describe('PageObserver', () => {
  let controller: BrowserController;
  let observer: PageObserver;

  const testHTML = `data:text/html,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><title>Test Page</title></head>
    <body>
      <header>
        <nav>
          <a href="/" id="home-link">Home</a>
          <a href="/about">About</a>
          <a href="https://external.com">External</a>
        </nav>
      </header>
      <main>
        <h1>Test Page</h1>
        <p>Some content here.</p>
        <form>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" placeholder="you@example.com" required />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" />
          <select id="role" name="role">
            <option>Admin</option>
            <option>User</option>
          </select>
          <button type="submit">Submit</button>
        </form>
      </main>
    </body>
    </html>
  `)}`;

  beforeAll(async () => {
    controller = new BrowserController();
    await controller.launch({ headless: true });
    await controller.navigateTo(testHTML);
    observer = new PageObserver();
  }, 15000);

  afterAll(async () => {
    await controller.close();
  });

  it('extracts simplified DOM with semantic elements only', async () => {
    const dom = await observer.getSimplifiedDOM(controller.currentPage());
    expect(dom).toContain('<h1>');
    expect(dom).toContain('<form>');
    expect(dom).toContain('<input');
    expect(dom).toContain('<button');
    expect(dom).not.toContain('<script');
    expect(dom).not.toContain('<style');
  }, 10000);

  it('takes viewport screenshot', async () => {
    const screenshot = await observer.takeScreenshot(controller.currentPage());
    expect(screenshot).toBeInstanceOf(Buffer);
    expect(screenshot.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(screenshot[0]).toBe(0x89);
    expect(screenshot[1]).toBe(0x50);
  }, 10000);

  it('generates page fingerprint', async () => {
    const fp1 = await observer.getPageFingerprint(controller.currentPage());
    expect(fp1).toHaveLength(16);

    // Same page = same fingerprint
    const fp2 = await observer.getPageFingerprint(controller.currentPage());
    expect(fp1).toBe(fp2);
  }, 10000);

  it('extracts page metadata', async () => {
    const meta = await observer.getPageMetadata(controller.currentPage());
    expect(meta.title).toBe('Test Page');
    expect(meta.url).toContain('data:text/html');
  }, 10000);

  it('finds interactive elements', async () => {
    const elements = await observer.getInteractiveElements(controller.currentPage());
    expect(elements.length).toBeGreaterThan(0);

    const button = elements.find((e) => e.tag === 'button');
    expect(button).toBeTruthy();
    expect(button?.text).toContain('Submit');

    const links = elements.filter((e) => e.tag === 'a');
    expect(links.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('extracts form fields', async () => {
    const fields = await observer.getFormFields(controller.currentPage());

    const email = fields.find((f) => f.name === 'email');
    expect(email).toBeTruthy();
    expect(email?.type).toBe('email');
    expect(email?.required).toBe(true);
    expect(email?.label).toContain('Email');
    expect(email?.placeholder).toBe('you@example.com');

    const select = fields.find((f) => f.tag === 'select');
    expect(select).toBeTruthy();
    expect(select?.options).toContain('Admin');
    expect(select?.options).toContain('User');
  }, 10000);

  it('extracts links with external detection', async () => {
    const links = await observer.getLinks(controller.currentPage());
    expect(links.length).toBeGreaterThanOrEqual(3);

    const external = links.find((l) => l.href === 'https://external.com');
    expect(external?.isExternal).toBe(true);

    const home = links.find((l) => l.href === '/');
    expect(home?.isExternal).toBe(false);
  }, 10000);

  it('produces full observation', async () => {
    const obs = await observer.observe(controller.currentPage());
    expect(obs.title).toBe('Test Page');
    expect(obs.fingerprint).toHaveLength(16);
    expect(obs.simplifiedDOM).toContain('<h1>');
    expect(obs.screenshot).toBeInstanceOf(Buffer);
    expect(obs.interactiveElements.length).toBeGreaterThan(0);
    expect(obs.forms.length).toBeGreaterThan(0);
    expect(obs.links.length).toBeGreaterThan(0);
    expect(obs.accessibilityTree).toBeTruthy();
  }, 15000);
});
