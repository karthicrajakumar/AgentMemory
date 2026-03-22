/**
 * Smoke test: exercises the core Replaybot flow against a local test app.
 * Runs against compiled dist/ to avoid tsx __name injection issues.
 *
 * Run: node test/smoke.mjs
 */

import { createServer } from 'http';
import { BrowserController } from '../dist/browser/controller.js';
import { PageObserver } from '../dist/browser/observer.js';
import { ActionExecutor } from '../dist/browser/actions.js';
import { LLMClient, UsageTracker } from '../dist/llm/interface.js';
import { PageStateManager } from '../dist/state/page-state.js';
import { SiteMapManager } from '../dist/state/sitemap.js';
import { ScoutAgent } from '../dist/agents/scout.js';
import { DeepExplorerAgent } from '../dist/agents/deep-explorer.js';
import { RecordingManager } from '../dist/state/recordings.js';
import { ElementAssertionEngine } from '../dist/assertions/element.js';

const PORT = 3457;
const BASE_URL = `http://localhost:${PORT}`;

// ── Test Web App ───────────────────────────────────────────────

const PAGES = {
  '/': '<html><head><title>Home</title></head><body><header><nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a> | <a href="/signup">Sign Up</a></nav></header><main><h1>Welcome</h1><p>Test app for Replaybot.</p><ul><li><a href="/products">Products</a></li><li><a href="/contact">Contact</a></li></ul></main><footer><p>Footer</p></footer></body></html>',
  '/about': '<html><head><title>About</title></head><body><header><nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a></nav></header><main><h1>About Us</h1><p>Test company.</p></main><footer><p>Footer</p></footer></body></html>',
  '/login': '<html><head><title>Login</title></head><body><header><nav><a href="/">Home</a> | <a href="/signup">Sign Up</a></nav></header><main><h1>Login</h1><form id="login-form"><label for="email">Email:</label><input type="email" id="email" name="email" placeholder="you@example.com" required><label for="password">Password:</label><input type="password" id="password" name="password" required><button type="submit">Log In</button></form></main><footer><p>Footer</p></footer></body></html>',
  '/signup': '<html><head><title>Sign Up</title></head><body><header><nav><a href="/">Home</a> | <a href="/login">Login</a></nav></header><main><h1>Create Account</h1><form id="signup-form"><label for="name">Name:</label><input type="text" id="name" name="name" required><label for="signup-email">Email:</label><input type="email" id="signup-email" name="email" required><label for="signup-password">Password:</label><input type="password" id="signup-password" name="password" required><label for="confirm">Confirm:</label><input type="password" id="confirm" name="confirm_password" required><button type="submit">Create Account</button></form></main><footer><p>Footer</p></footer></body></html>',
  '/products': '<html><head><title>Products</title></head><body><header><nav><a href="/">Home</a> | <a href="/products">Products</a></nav></header><main><h1>Products</h1><ul><li><a href="/products/1">Widget A</a></li><li><a href="/products/2">Widget B</a></li></ul><form id="search"><input type="text" name="q" placeholder="Search..."><button type="submit">Search</button></form></main><footer><p>Footer</p></footer></body></html>',
  '/contact': '<html><head><title>Contact</title></head><body><header><nav><a href="/">Home</a> | <a href="/contact">Contact</a></nav></header><main><h1>Contact</h1><form id="contact-form"><label for="cname">Name:</label><input type="text" id="cname" name="name" required><label for="cemail">Email:</label><input type="email" id="cemail" name="email" required><label for="msg">Message:</label><textarea id="msg" name="message" required></textarea><button type="submit">Send</button></form></main><footer><p>Footer</p></footer></body></html>',
};

function startApp() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url?.split('?')[0] ?? '/';
      const html = PAGES[url];
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('<h1>404</h1>');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

// ── Mock LLM ───────────────────────────────────────────────────

class MockLLM {
  name = 'mock';
  async complete(request) {
    const msg = request.messages[request.messages.length - 1]?.content ?? '';
    if (msg.includes('Classify this web page')) {
      if (msg.includes('password') && msg.includes('confirm')) {
        return { content: '{"pageType":"register","description":"Signup page","isAuthGated":false}', usage: { inputTokens: 50, outputTokens: 30 } };
      }
      if (msg.includes('password')) {
        return { content: '{"pageType":"login","description":"Login page","isAuthGated":false,"authType":"login_form"}', usage: { inputTokens: 50, outputTokens: 30 } };
      }
      return { content: '{"pageType":"other","description":"Page","isAuthGated":false}', usage: { inputTokens: 50, outputTokens: 30 } };
    }
    if (msg.includes('Analyze this web page')) {
      return { content: '{"pageType":"form","purpose":"A page","interactionMap":[{"elementSelector":"button","elementDescription":"Button","expectedOutcome":"Submits","confidence":"high","sideEffects":[],"stateChanges":[]}],"formAnalyses":[],"dynamicRegions":[],"suggestedTestScenarios":["Fill form","Check validation"]}', usage: { inputTokens: 200, outputTokens: 150 } };
    }
    return { content: '{}', usage: { inputTokens: 10, outputTokens: 10 } };
  }
  async *stream() { yield { type: 'done' }; }
  supportsVision() { return true; }
  supportsToolUse() { return true; }
  maxContextTokens() { return 200000; }
}

// ── Helpers ──────────────────────────────────────────────────────

function log(step, msg) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${step}`);
  console.log(`${'='.repeat(60)}`);
  console.log(msg);
}

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ── Main ────────────────────────────────────────────────────────

const app = await startApp();
console.log(`Replaybot Smoke Test — local app at ${BASE_URL}`);

const browser = new BrowserController();
await browser.launch({ headless: true, browserType: 'chromium' });

const observer = new PageObserver();
const actions = new ActionExecutor(browser.currentPage());
const llm = new LLMClient(new MockLLM(), { provider: 'mock', fastModel: 'mock', balancedModel: 'mock', premiumModel: 'mock', apiKey: 'x' }, new UsageTracker());
const pageState = new PageStateManager('/tmp/replaybot-smoke2/state.json');
const sitemap = new SiteMapManager(BASE_URL, '/tmp/replaybot-smoke2/sitemap.json');
const ctx = { browser, observer, actions, llm, pageState, sitemap };

try {
  // 1. Scout
  log('1. SCOUT', `Discovering pages at ${BASE_URL}...`);
  const scout = new ScoutAgent(ctx);
  await scout.scoutApp(BASE_URL, { maxPages: 15, maxDepth: 3, delayBetweenPages: 100 });

  const sm = sitemap.getSiteMap();
  console.log(`  Pages: ${sm.pages.size}`);
  for (const [url] of sm.pages) console.log(`    - ${url}`);
  check('Discovered multiple pages', sm.pages.size >= 4);
  check('Found login page', [...sm.pages.keys()].some(u => u.includes('/login')));
  check('Found signup page', [...sm.pages.keys()].some(u => u.includes('/signup')));
  check('Built navigation edges', sm.edges.length > 0);

  // 2. Observe
  log('2. OBSERVE', 'Full observation on signup page...');
  await browser.navigateTo(`${BASE_URL}/signup`);
  const obs = await observer.observe(browser.currentPage());
  check('Got page title', obs.title.includes('Sign Up'));
  check('Got fingerprint', obs.fingerprint.length === 16);
  check('Found form fields', obs.forms.length >= 3);
  check('Got screenshot', obs.screenshot.length > 500);
  check('Got simplified DOM', obs.simplifiedDOM.length > 50);
  console.log(`  Elements: ${obs.interactiveElements.length}, Forms: ${obs.forms.length}, Links: ${obs.links.length}`);

  // 3. Deep Explore
  log('3. DEEP EXPLORE', 'Analyzing signup page...');
  const explorer = new DeepExplorerAgent(ctx);
  const deep = await explorer.explorePage(`${BASE_URL}/signup`);
  check('Got analysis', !!deep.analysis);
  check('Got test scenarios', deep.analysis.suggestedTestScenarios.length > 0);
  console.log(`  Scenarios: ${deep.analysis.suggestedTestScenarios.join(', ')}`);

  // 4. Record
  log('4. RECORD', 'Recording signup flow...');
  const recMgr = new RecordingManager('/tmp/replaybot-smoke2/recordings');
  recMgr.startRecording('signup-flow', BASE_URL, 'Signup test');
  const page = browser.currentPage();

  await page.locator('#name').fill('John Doe');
  recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#name' }] }, value: 'John Doe', description: 'Fill name', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

  await page.locator('#signup-email').fill('john@example.com');
  recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#signup-email' }] }, value: 'john@example.com', description: 'Fill email', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

  await page.locator('#signup-password').fill('SecurePass123!');
  recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#signup-password' }] }, value: 'SecurePass123!', description: 'Fill password', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

  const recording = recMgr.stopRecording();
  const savedPath = await recMgr.saveRecording(recording);
  check('Recorded 3 actions', recording.actions.length === 3);
  check('Saved to disk', savedPath.endsWith('.json'));

  // 5. Parameter detection
  const params = RecordingManager.detectParameters(recording);
  check('Detected email param', params.some(p => p.type === 'email'));
  check('Detected password param', params.some(p => p.type === 'password'));
  console.log(`  Params: ${params.map(p => `${p.name}(${p.type})`).join(', ')}`);

  // 6. Assertions
  log('5. ASSERTIONS', 'Testing element assertions...');
  const assertEng = new ElementAssertionEngine();
  const vis = await assertEng.assertVisible(page, { selectors: [{ strategy: 'css', value: '#signup-form' }] });
  check('Form is visible', vis.pass);
  const title = await assertEng.assertTitle(page, 'Sign Up');
  check('Title matches', title.pass);
  const url = await assertEng.assertUrl(page, '/signup');
  check('URL matches', url.pass);

  // 7. Playwright export
  log('6. EXPORT', 'Generating Playwright test...');
  const pw = RecordingManager.exportAsPlaywrightTest(recording);
  check('Has test()', pw.includes("test('"));
  check('Has page.locator', pw.includes('page.locator'));
  console.log(`  ${pw.split('\n').length} lines generated`);

  // 8. Persistence
  log('7. PERSISTENCE', 'Sitemap save/load...');
  await sitemap.save();
  const sm2 = new SiteMapManager('', '/tmp/replaybot-smoke2/sitemap.json');
  await sm2.load();
  check('Sitemap reloads correctly', sm2.getPageCount() === sm.pages.size);

} finally {
  await browser.close();
  app.close();
}

log('RESULT', `${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('\n  All checks passed!\n');
