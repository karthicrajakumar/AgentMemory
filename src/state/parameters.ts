import { readFile } from 'fs/promises';
import { extname } from 'path';
import type { LLMClient } from '../llm/interface.js';
import type { ParameterDef } from './recordings.js';

// ── Rule-Based Generators ──────────────────────────────────────

const GENERATORS: Record<string, () => string> = {
  email: () => {
    const names = ['test', 'user', 'demo', 'sample', 'qa'];
    const domains = ['example.com', 'test.org', 'demo.net'];
    const name = names[Math.floor(Math.random() * names.length)];
    const num = Math.floor(Math.random() * 9999);
    const domain = domains[Math.floor(Math.random() * domains.length)];
    return `${name}${num}@${domain}`;
  },
  password: () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    let pw = '';
    for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    return pw;
  },
  string: () => {
    const words = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Test', 'Demo', 'Sample'];
    return words[Math.floor(Math.random() * words.length)] + Math.floor(Math.random() * 999);
  },
  number: () => String(Math.floor(Math.random() * 10000)),
  boolean: () => (Math.random() > 0.5 ? 'true' : 'false'),
  username: () => {
    const adjectives = ['fast', 'cool', 'happy', 'smart', 'brave'];
    const nouns = ['fox', 'tiger', 'eagle', 'wolf', 'bear'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj}_${noun}${Math.floor(Math.random() * 999)}`;
  },
  phone: () => {
    const area = Math.floor(Math.random() * 900) + 100;
    const mid = Math.floor(Math.random() * 900) + 100;
    const end = Math.floor(Math.random() * 9000) + 1000;
    return `(${area}) ${mid}-${end}`;
  },
  name: () => {
    const firsts = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry'];
    const lasts = ['Smith', 'Jones', 'Brown', 'Wilson', 'Taylor', 'Clark', 'Hall', 'Lee'];
    return `${firsts[Math.floor(Math.random() * firsts.length)]} ${lasts[Math.floor(Math.random() * lasts.length)]}`;
  },
};

// Invalid value generators (for negative testing)
const INVALID_GENERATORS: Record<string, () => string[]> = {
  email: () => ['not-an-email', '@missing-name.com', 'no-domain@', 'spaces in@email.com', ''],
  password: () => ['', 'a', '12', 'no-special-chars', '   '],
  string: () => ['', ' ', '<script>alert(1)</script>', 'a'.repeat(500)],
  number: () => ['abc', '-1', '99999999999', '', '3.14.15'],
  boolean: () => ['maybe', '2', '', 'null'],
};

// ── Parameter Engine ───────────────────────────────────────────

export class ParameterEngine {
  private llm?: LLMClient;

  constructor(llm?: LLMClient) {
    this.llm = llm;
  }

  /**
   * Resolve template strings: "{{email}}" → "test42@example.com"
   */
  resolveTemplate(template: string, params: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
  }

  /**
   * Generate valid test data for parameters using rule-based generators.
   */
  generateTestData(params: ParameterDef[]): Record<string, string> {
    const data: Record<string, string> = {};
    for (const param of params) {
      const gen = GENERATORS[param.type] ?? GENERATORS.string;
      data[param.name] = gen();
    }
    return data;
  }

  /**
   * Generate invalid/edge-case test data for negative testing.
   */
  generateInvalidData(params: ParameterDef[]): Record<string, string[]> {
    const data: Record<string, string[]> = {};
    for (const param of params) {
      const gen = INVALID_GENERATORS[param.type] ?? INVALID_GENERATORS.string;
      data[param.name] = gen();
    }
    return data;
  }

  /**
   * Generate test data using LLM for complex/contextual scenarios.
   * Falls back to rule-based if LLM is unavailable.
   */
  async generateContextualData(
    params: ParameterDef[],
    scenario: string,
  ): Promise<Record<string, string>> {
    if (!this.llm) {
      return this.generateTestData(params);
    }

    const paramSummary = params
      .map((p) => `- ${p.name} (${p.type}): ${p.description}${p.constraints ? ` [${p.constraints}]` : ''}`)
      .join('\n');

    try {
      const response = await this.llm.complete({
        systemPrompt: 'You are a test data generator. Generate realistic test data for the given scenario. Respond with valid JSON only.',
        messages: [
          {
            role: 'user',
            content: `Generate test data for this scenario: "${scenario}"

Parameters:
${paramSummary}

Respond with JSON:
{ "<param_name>": "<value>", ... }

Make values realistic and appropriate for the scenario.`,
          },
        ],
        modelTier: 'fast',
        agentId: 'parameter-engine',
        temperature: 0.5,
        maxTokens: 500,
      });

      const parsed = JSON.parse(response.content);
      const result: Record<string, string> = {};
      for (const param of params) {
        result[param.name] = parsed[param.name] != null ? String(parsed[param.name]) : param.defaultValue;
      }
      return result;
    } catch {
      return this.generateTestData(params);
    }
  }

  /**
   * Create N variations of parameter data for data-driven testing.
   */
  createDataSet(params: ParameterDef[], count: number): Record<string, string>[] {
    const dataSet: Record<string, string>[] = [];
    for (let i = 0; i < count; i++) {
      dataSet.push(this.generateTestData(params));
    }
    return dataSet;
  }

  /**
   * Load parameter data from an external CSV or JSON file.
   */
  async loadDataFile(filePath: string): Promise<Record<string, string>[]> {
    const content = await readFile(filePath, 'utf-8');
    const ext = extname(filePath).toLowerCase();

    if (ext === '.json') {
      return this.parseJSON(content);
    } else if (ext === '.csv') {
      return this.parseCSV(content);
    } else {
      throw new Error(`Unsupported data file format: ${ext}. Use .json or .csv`);
    }
  }

  private parseJSON(content: string): Record<string, string>[] {
    const parsed = JSON.parse(content);

    // Support both array of objects and { data: [...] } format
    const rows = Array.isArray(parsed) ? parsed : parsed.data;
    if (!Array.isArray(rows)) {
      throw new Error('JSON data file must contain an array or { data: [...] }');
    }

    return rows.map((row: Record<string, unknown>) => {
      const stringRow: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        stringRow[key] = String(value);
      }
      return stringRow;
    });
  }

  private parseCSV(content: string): Record<string, string>[] {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return [];

    // Parse header
    const headers = this.parseCSVLine(lines[0]);

    // Parse data rows
    return lines.slice(1).map((line) => {
      const values = this.parseCSVLine(line);
      const row: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]] = values[i] ?? '';
      }
      return row;
    });
  }

  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }
}
