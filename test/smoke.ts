/**
 * Smoke test: exercises the core Replaybot flow against a local test app.
 *
 * Run: npx tsx test/smoke.ts
 */

import { startTestApp } from './test-app.js';
import { BrowserController } from '../src/browser/controller.js';
import { PageObserver } from '../src/browser/observer.js';
import { ActionExecutor } from '../src/browser/actions.js';
import { LLMClient, UsageTracker, type LLMProvider, type LLMRequest, type LLMResponse, type LLMStreamChunk } from '../src/llm/interface.js';
import { PageStateManager } from '../src/state/page-state.js';
import { SiteMapManager } from '../src/state/sitemap.js';
import { ScoutAgent } from '../src/agents/scout.js';
import { DeepExplorerAgent } from '../src/agents/deep-explorer.js';
import { RecordingManager } from '../src/state/recordings.js';
import { ElementAssertionEngine } from '../src/assertions/element.js';
import type { AgentContext } from '../src/agents/types.js';

const PORT = 3456;
const BASE_URL = `http://localhost:${PORT}`;

// ── Mock LLM ───────────────────────────────────────────────────

class MockLLMProvider implements LLMProvider {
  name = 'mock';

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const userMsg = request.messages[request.messages.length - 1]?.content ?? '';

    if (userMsg.includes('Classify this web page')) {
      // Detect login/signup from DOM
      if (userMsg.includes('password') && userMsg.includes('email')) {
        const isSignup = userMsg.includes('signup') || userMsg.includes('Sign Up') || userMsg.includes('confirm');
        return {
          content: JSON.stringify({
            pageType: isSignup ? 'register' : 'login',
            description: isSignup ? 'User registration page' : 'Login page',
            isAuthGated: false,
            authType: isSignup ? null : 'login_form',
          }),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      if (userMsg.includes('Product')) {
        return {
          content: JSON.stringify({ pageType: 'listing', description: 'Product listing page', isAuthGated: false }),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      if (userMsg.includes('Dashboard')) {
        return {
          content: JSON.stringify({ pageType: 'dashboard', description: 'User dashboard', isAuthGated: true, authType: 'login_form' }),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        content: JSON.stringify({ pageType: 'other', description: 'General page', isAuthGated: false }),
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }

    if (userMsg.includes('Analyze this web page deeply')) {
      return {
        content: JSON.stringify({
          pageType: 'form',
          purpose: 'Web page with interactive elements',
          interactionMap: [
            { elementSelector: 'button[type="submit"]', elementDescription: 'Submit button', expectedOutcome: 'Submits the form', confidence: 'high', sideEffects: [], stateChanges: [] },
          ],
          formAnalyses: [],
          dynamicRegions: [],
          suggestedTestScenarios: ['Fill and submit the form', 'Validate required fields'],
        }),
        usage: { inputTokens: 300, outputTokens: 200 },
      };
    }

    return { content: '{}', usage: { inputTokens: 10, outputTokens: 10 } };
  }

  async *stream(): AsyncIterable<LLMStreamChunk> {
    yield { type: 'done' };
  }

  supportsVision() { return true; }
  supportsToolUse() { return true; }
  maxContextTokens() { return 200_000; }
}

// ── Helpers ──────────────────────────────────────────────────────

function log(step: string, msg: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${step}`);
  console.log(`${'='.repeat(60)}`);
  console.log(msg);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('Replaybot Smoke Test (local test app)');

  // Start test app
  const app = await startTestApp(PORT);
  console.log(`Test app running at ${BASE_URL}`);

  const browser = new BrowserController();
  await browser.launch({ headless: true, browserType: 'chromium' });

  const observer = new PageObserver();
  const actions = new ActionExecutor(browser.currentPage());
  const llm = new LLMClient(new MockLLMProvider(), {
    provider: 'mock', fastModel: 'mock', balancedModel: 'mock', premiumModel: 'mock', apiKey: 'mock',
  }, new UsageTracker());
  const pageState = new PageStateManager('/tmp/replaybot-smoke/state.json');
  const sitemap = new SiteMapManager(BASE_URL, '/tmp/replaybot-smoke/sitemap.json');
  const ctx: AgentContext = { browser, observer, actions, llm, pageState, sitemap };

  try {
    // ── 1. Scout ──
    log('1. SCOUT', `Discovering pages at ${BASE_URL}...`);
    const scout = new ScoutAgent(ctx);
    await scout.scoutApp(BASE_URL, { maxPages: 15, maxDepth: 3, delayBetweenPages: 100 });

    const sm = sitemap.getSiteMap();
    console.log(`  Pages: ${sm.pages.size}`);
    for (const [url] of sm.pages) {
      console.log(`    - ${url}`);
    }
    check('Discovered multiple pages', sm.pages.size >= 5);
    check('Found login page', [...sm.pages.keys()].some((u) => u.includes('/login')));
    check('Found signup page', [...sm.pages.keys()].some((u) => u.includes('/signup')));
    check('Found products page', [...sm.pages.keys()].some((u) => u.includes('/products')));
    check('Built navigation edges', sm.edges.length > 0);

    // ── 2. Observe ──
    log('2. OBSERVE', 'Full page observation on signup page...');
    await browser.navigateTo(`${BASE_URL}/signup`);
    const obs = await observer.observe(browser.currentPage());

    check('Got page URL', obs.url.includes('/signup'));
    check('Got page title', obs.title.includes('Sign Up'));
    check('Got fingerprint', obs.fingerprint.length === 16);
    check('Found interactive elements', obs.interactiveElements.length > 0);
    check('Found form fields', obs.forms.length >= 4); // name, email, password, confirm
    check('Got screenshot buffer', obs.screenshot.length > 1000);
    check('Got simplified DOM', obs.simplifiedDOM.length > 100);

    // ── 3. Deep Explore ──
    log('3. DEEP EXPLORE', 'Analyzing signup page...');
    const explorer = new DeepExplorerAgent(ctx);
    const deepResult = await explorer.explorePage(`${BASE_URL}/signup`);

    check('Got page analysis', !!deepResult.analysis);
    check('Got interaction map', deepResult.analysis.interactionMap.length > 0);
    check('Got test scenarios', deepResult.analysis.suggestedTestScenarios.length > 0);
    console.log(`  Scenarios: ${deepResult.analysis.suggestedTestScenarios.join(', ')}`);

    // ── 4. Record Actions ──
    log('4. RECORD', 'Recording a signup flow...');
    const recMgr = new RecordingManager('/tmp/replaybot-smoke/recordings');
    recMgr.startRecording('signup-flow', BASE_URL, 'Test signup flow');

    // Navigate to signup
    await browser.navigateTo(`${BASE_URL}/signup`);
    const page = browser.currentPage();

    // Fill form
    await page.locator('#name').fill('John Doe');
    recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#name' }] }, value: 'John Doe', description: 'Fill name', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

    await page.locator('#signup-email').fill('john@example.com');
    recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#signup-email' }] }, value: 'john@example.com', description: 'Fill email', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

    await page.locator('#signup-password').fill('SecurePass123!');
    recMgr.recordAction({ type: 'type', selectors: { selectors: [{ strategy: 'css', value: '#signup-password' }] }, value: 'SecurePass123!', description: 'Fill password', url: page.url(), timestamp: Date.now(), duration: 50, success: true });

    const recording = recMgr.stopRecording();
    const savedPath = await recMgr.saveRecording(recording);

    check('Recording has 3 actions', recording.actions.length === 3);
    check('Recording saved to disk', savedPath.includes('.json'));
    check('Recording has ID', recording.id.length > 0);

    // Auto-detect parameters
    const params = RecordingManager.detectParameters(recording);
    check('Auto-detected email parameter', params.some((p) => p.type === 'email'));
    check('Auto-detected password parameter', params.some((p) => p.type === 'password'));
    console.log(`  Detected params: ${params.map((p) => `${p.name}(${p.type})`).join(', ')}`);

    // ── 5. Assertions ──
    log('5. ASSERTIONS', 'Testing element assertions...');
    const assertEngine = new ElementAssertionEngine();

    const visResult = await assertEngine.assertVisible(page, { selectors: [{ strategy: 'css', value: '#signup-form' }] });
    check('Assert visible: signup form', visResult.pass);

    const titleResult = await assertEngine.assertTitle(page, 'Sign Up');
    check('Assert title contains "Sign Up"', titleResult.pass);

    const urlResult = await assertEngine.assertUrl(page, '/signup');
    check('Assert URL contains /signup', urlResult.pass);

    // ── 6. Sitemap Persistence ──
    log('6. PERSISTENCE', 'Save and reload sitemap...');
    await sitemap.save();
    const sitemap2 = new SiteMapManager('', '/tmp/replaybot-smoke/sitemap.json');
    await sitemap2.load();
    check('Sitemap persists and reloads', sitemap2.getPageCount() === sm.pages.size);

    // ── 7. Recording List ──
    log('7. RECORDINGS', 'Listing saved recordings...');
    const recordings = await recMgr.listRecordings();
    check('Recording appears in list', recordings.length >= 1);
    check('Recording has correct name', recordings.some((r) => r.name === 'signup-flow'));

    // ── 8. Playwright Export ──
    log('8. EXPORT', 'Generating Playwright test...');
    const pwTest = RecordingManager.exportAsPlaywrightTest(recording);
    check('Export contains test()', pwTest.includes("test('"));
    check('Export contains page.locator', pwTest.includes('page.locator'));
    check('Export contains fill()', pwTest.includes('.fill('));
    console.log(`  Generated ${pwTest.split('\n').length} lines of Playwright test code`);

  } finally {
    await browser.close();
    app.close();
  }

  // ── Summary ──
  log('RESULT', `${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n  All checks passed!\n');
  }
}

main().catch((err) => {
  console.error('Smoke test FAILED:', err);
  process.exit(1);
});
