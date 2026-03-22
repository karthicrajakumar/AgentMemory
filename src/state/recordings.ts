import { v4 as uuidv4 } from 'uuid';
import { writeFile, readFile, readdir, mkdir, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import type { SelectorChain, SelectorEntry } from '../types/index.js';
import type { SiteMap } from './sitemap.js';

// ── Types ──────────────────────────────────────────────────────

export type ActionType = 'click' | 'type' | 'select' | 'hover' | 'scroll' | 'navigate' | 'wait' | 'screenshot';

export interface ActionRecord {
  id: string;
  order: number;
  type: ActionType;
  selectors?: SelectorChain;
  value?: string;
  description: string;
  url: string; // page URL when action was performed
  timestamp: number;
  duration: number;
  success: boolean;
  error?: string;
  screenshotBefore?: string; // file path
  screenshotAfter?: string;  // file path
}

export interface AssertionResult {
  pass: boolean;
  message: string;
  expected?: string;
  actual?: string;
  screenshotPath?: string;
  duration: number;
}

export interface AssertionRecord {
  id: string;
  afterActionId: string;
  type: 'element_visible' | 'text_content' | 'url_match' | 'title_match' | 'element_count' | 'attribute' | 'visual' | 'custom';
  description: string;
  selectors?: SelectorChain;
  expected: string;
  result: AssertionResult;
  timestamp: number;
}

export interface ParameterDef {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'email' | 'password';
  defaultValue: string;
  constraints?: string;
}

export interface Recording {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  baseUrl: string;
  parameters: ParameterDef[];
  actions: ActionRecord[];
  assertions: AssertionRecord[];
  sitemapSnapshot?: Partial<SerializedSiteMapSnapshot>;
  metadata: RecordingMetadata;
}

export interface RecordingMetadata {
  durationMs: number;
  agentTokenUsage: { input: number; output: number };
  pagesVisited: string[];
  selfHealedCount: number;
}

export interface RecordingSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  actionCount: number;
  assertionCount: number;
  baseUrl: string;
}

interface SerializedSiteMapSnapshot {
  entryUrl: string;
  pages: Record<string, unknown>;
  edges: Array<{ from: string; to: string; action: string }>;
}

// ── Recording Manager ──────────────────────────────────────────

const DEFAULT_RECORDINGS_DIR = '.replaybot/recordings';
const DEFAULT_SCREENSHOTS_DIR = '.replaybot/screenshots/recordings';

export class RecordingManager {
  private currentRecording: Recording | null = null;
  private actionCounter = 0;
  private recordingsDir: string;
  private screenshotsDir: string;

  constructor(recordingsDir?: string, screenshotsDir?: string) {
    this.recordingsDir = recordingsDir ?? DEFAULT_RECORDINGS_DIR;
    this.screenshotsDir = screenshotsDir ?? DEFAULT_SCREENSHOTS_DIR;
  }

  // ── Lifecycle ──

  startRecording(name: string, baseUrl: string, description = ''): Recording {
    if (this.currentRecording) {
      throw new Error('A recording is already in progress. Stop it first.');
    }

    this.actionCounter = 0;
    this.currentRecording = {
      id: uuidv4(),
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseUrl,
      parameters: [],
      actions: [],
      assertions: [],
      metadata: {
        durationMs: 0,
        agentTokenUsage: { input: 0, output: 0 },
        pagesVisited: [],
        selfHealedCount: 0,
      },
    };

    return this.currentRecording;
  }

  stopRecording(): Recording {
    if (!this.currentRecording) {
      throw new Error('No recording in progress.');
    }

    const recording = this.currentRecording;

    // Calculate duration
    if (recording.actions.length > 0) {
      const firstAction = recording.actions[0];
      const lastAction = recording.actions[recording.actions.length - 1];
      recording.metadata.durationMs = (lastAction.timestamp + lastAction.duration) - firstAction.timestamp;
    }

    // Deduplicate pages visited
    recording.metadata.pagesVisited = [...new Set(recording.metadata.pagesVisited)];
    recording.updatedAt = new Date().toISOString();

    this.currentRecording = null;
    return recording;
  }

  isRecording(): boolean {
    return this.currentRecording !== null;
  }

  getCurrentRecording(): Recording | null {
    return this.currentRecording;
  }

  // ── Action Capture ──

  recordAction(action: Omit<ActionRecord, 'id' | 'order'>): ActionRecord {
    if (!this.currentRecording) {
      throw new Error('No recording in progress. Call startRecording() first.');
    }

    const record: ActionRecord = {
      ...action,
      id: uuidv4(),
      order: this.actionCounter++,
    };

    this.currentRecording.actions.push(record);

    // Track pages visited
    if (action.url && !this.currentRecording.metadata.pagesVisited.includes(action.url)) {
      this.currentRecording.metadata.pagesVisited.push(action.url);
    }

    this.currentRecording.updatedAt = new Date().toISOString();
    return record;
  }

  recordAssertion(assertion: Omit<AssertionRecord, 'id'>): AssertionRecord {
    if (!this.currentRecording) {
      throw new Error('No recording in progress.');
    }

    const record: AssertionRecord = {
      ...assertion,
      id: uuidv4(),
    };

    this.currentRecording.assertions.push(record);
    this.currentRecording.updatedAt = new Date().toISOString();
    return record;
  }

  async recordScreenshot(
    actionId: string,
    timing: 'before' | 'after',
    buffer: Buffer,
  ): Promise<string> {
    if (!this.currentRecording) {
      throw new Error('No recording in progress.');
    }

    const dir = join(this.screenshotsDir, this.currentRecording.id);
    await mkdir(dir, { recursive: true });

    const filename = `${actionId}-${timing}.png`;
    const filepath = join(dir, filename);
    await writeFile(filepath, buffer);

    // Update the action record
    const action = this.currentRecording.actions.find((a) => a.id === actionId);
    if (action) {
      if (timing === 'before') action.screenshotBefore = filepath;
      else action.screenshotAfter = filepath;
    }

    return filepath;
  }

  trackTokenUsage(input: number, output: number): void {
    if (!this.currentRecording) return;
    this.currentRecording.metadata.agentTokenUsage.input += input;
    this.currentRecording.metadata.agentTokenUsage.output += output;
  }

  trackSelfHeal(): void {
    if (!this.currentRecording) return;
    this.currentRecording.metadata.selfHealedCount++;
  }

  // ── Selector Chain Capture ──

  static buildSelectorChain(
    element: {
      id?: string;
      role?: string;
      ariaLabel?: string;
      testId?: string;
      text?: string;
      tag?: string;
      type?: string;
      name?: string;
      cssSelector?: string;
    },
  ): SelectorChain {
    const selectors: SelectorEntry[] = [];

    // 1. ARIA role + name (highest priority)
    if (element.role && element.ariaLabel) {
      selectors.push({ strategy: 'aria', value: `${element.role}[name="${element.ariaLabel}"]` });
    }

    // 2. Test ID
    if (element.testId) {
      selectors.push({ strategy: 'testid', value: element.testId });
    }

    // 3. CSS with ID
    if (element.id) {
      selectors.push({ strategy: 'css', value: `#${element.id}` });
    }

    // 4. Text content
    if (element.text && element.text.length < 100) {
      selectors.push({ strategy: 'text', value: element.text });
    }

    // 5. CSS selector (generated or provided)
    if (element.cssSelector) {
      selectors.push({ strategy: 'css', value: element.cssSelector });
    }

    // 6. Fallback: tag + type + name
    if (element.tag && selectors.length === 0) {
      let css = element.tag;
      if (element.type) css += `[type="${element.type}"]`;
      if (element.name) css += `[name="${element.name}"]`;
      selectors.push({ strategy: 'css', value: css });
    }

    return { selectors, totalTimeout: 15000 };
  }

  // ── Parameter Detection ──

  static detectParameters(recording: Recording): ParameterDef[] {
    const params: ParameterDef[] = [];
    const seen = new Set<string>();

    for (const action of recording.actions) {
      if (action.type !== 'type' || !action.value) continue;

      const value = action.value;
      const desc = action.description.toLowerCase();

      // Email detection
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !seen.has('email')) {
        params.push({
          name: 'email',
          description: 'Email address',
          type: 'email',
          defaultValue: value,
          constraints: 'valid email format',
        });
        seen.add('email');
        continue;
      }

      // Password detection
      if (desc.includes('password') && !seen.has('password')) {
        params.push({
          name: 'password',
          description: 'Password',
          type: 'password',
          defaultValue: value,
        });
        seen.add('password');
        continue;
      }

      // Username detection
      if ((desc.includes('username') || desc.includes('user name')) && !seen.has('username')) {
        params.push({
          name: 'username',
          description: 'Username',
          type: 'string',
          defaultValue: value,
        });
        seen.add('username');
        continue;
      }

      // Number detection
      if (/^\d+$/.test(value) && !seen.has(`number_${desc}`)) {
        const name = desc.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'number_value';
        params.push({
          name,
          description: action.description,
          type: 'number',
          defaultValue: value,
        });
        seen.add(`number_${desc}`);
      }
    }

    return params;
  }

  static parameterize(recording: Recording, params: ParameterDef[]): Recording {
    const parameterized = { ...recording, parameters: params };

    for (const action of parameterized.actions) {
      if (action.type !== 'type' || !action.value) continue;

      for (const param of params) {
        if (action.value === param.defaultValue) {
          action.value = `{{${param.name}}}`;
          break;
        }
      }
    }

    return parameterized;
  }

  // ── Storage ──

  async saveRecording(recording: Recording): Promise<string> {
    await mkdir(this.recordingsDir, { recursive: true });

    const slug = recording.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const shortId = recording.id.slice(0, 8);
    const filename = `${slug}-${shortId}.json`;
    const filepath = join(this.recordingsDir, filename);

    await writeFile(filepath, JSON.stringify(recording, null, 2), 'utf-8');
    return filepath;
  }

  async loadRecording(id: string): Promise<Recording> {
    const files = await readdir(this.recordingsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filepath = join(this.recordingsDir, file);
      const raw = await readFile(filepath, 'utf-8');
      const recording: Recording = JSON.parse(raw);
      if (recording.id === id) return recording;
    }
    throw new Error(`Recording not found: ${id}`);
  }

  async listRecordings(): Promise<RecordingSummary[]> {
    try {
      const files = await readdir(this.recordingsDir);
      const summaries: RecordingSummary[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filepath = join(this.recordingsDir, file);
          const raw = await readFile(filepath, 'utf-8');
          const recording: Recording = JSON.parse(raw);
          summaries.push({
            id: recording.id,
            name: recording.name,
            description: recording.description,
            createdAt: recording.createdAt,
            actionCount: recording.actions.length,
            assertionCount: recording.assertions.length,
            baseUrl: recording.baseUrl,
          });
        } catch {
          // Skip invalid files
        }
      }

      return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return []; // Directory doesn't exist yet
    }
  }

  async deleteRecording(id: string): Promise<void> {
    const files = await readdir(this.recordingsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filepath = join(this.recordingsDir, file);
      const raw = await readFile(filepath, 'utf-8');
      const recording: Recording = JSON.parse(raw);
      if (recording.id === id) {
        await unlink(filepath);
        return;
      }
    }
    throw new Error(`Recording not found: ${id}`);
  }

  // ── Export ──

  static exportAsPlaywrightTest(recording: Recording): string {
    const lines: string[] = [];

    lines.push(`import { test, expect } from '@playwright/test';`);
    lines.push('');
    lines.push(`test('${recording.name.replace(/'/g, "\\'")}', async ({ page }) => {`);

    // Parameters as variables
    if (recording.parameters.length > 0) {
      lines.push('  // Parameters — customize these values');
      for (const param of recording.parameters) {
        const value = param.type === 'number' ? param.defaultValue : `'${param.defaultValue.replace(/'/g, "\\'")}'`;
        lines.push(`  const ${param.name} = ${value};`);
      }
      lines.push('');
    }

    // Navigate to base URL
    lines.push(`  await page.goto('${recording.baseUrl}');`);
    lines.push('');

    for (const action of recording.actions) {
      lines.push(`  // ${action.description}`);

      const selector = action.selectors?.selectors[0];
      const selectorStr = selector ? toPlaywrightSelector(selector) : '';

      switch (action.type) {
        case 'click':
          if (selectorStr) lines.push(`  await page.locator('${esc(selectorStr)}').click();`);
          break;
        case 'type': {
          const val = action.value ?? '';
          const paramMatch = val.match(/^\{\{(\w+)\}\}$/);
          const valueStr = paramMatch ? paramMatch[1] : `'${esc(val)}'`;
          if (selectorStr) lines.push(`  await page.locator('${esc(selectorStr)}').fill(${valueStr});`);
          break;
        }
        case 'select':
          if (selectorStr) lines.push(`  await page.locator('${esc(selectorStr)}').selectOption('${esc(action.value ?? '')}');`);
          break;
        case 'hover':
          if (selectorStr) lines.push(`  await page.locator('${esc(selectorStr)}').hover();`);
          break;
        case 'scroll':
          lines.push(`  await page.mouse.wheel(0, ${action.value ?? '300'});`);
          break;
        case 'navigate':
          lines.push(`  await page.goto('${esc(action.value ?? action.url)}');`);
          break;
        case 'wait':
          lines.push(`  await page.waitForTimeout(${action.value ?? '1000'});`);
          break;
      }
      lines.push('');
    }

    // Assertions
    for (const assertion of recording.assertions) {
      lines.push(`  // Assert: ${assertion.description}`);
      const aSelector = assertion.selectors?.selectors[0];
      const aSelectorStr = aSelector ? toPlaywrightSelector(aSelector) : '';

      switch (assertion.type) {
        case 'element_visible':
          if (aSelectorStr) lines.push(`  await expect(page.locator('${esc(aSelectorStr)}')).toBeVisible();`);
          break;
        case 'text_content':
          if (aSelectorStr) lines.push(`  await expect(page.locator('${esc(aSelectorStr)}')).toContainText('${esc(assertion.expected)}');`);
          break;
        case 'url_match':
          lines.push(`  await expect(page).toHaveURL(/${esc(assertion.expected)}/);`);
          break;
        case 'title_match':
          lines.push(`  await expect(page).toHaveTitle(/${esc(assertion.expected)}/);`);
          break;
      }
      lines.push('');
    }

    lines.push('});');
    lines.push('');

    return lines.join('\n');
  }
}

// ── Helpers ──

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
