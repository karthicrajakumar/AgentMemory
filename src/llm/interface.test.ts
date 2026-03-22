import { describe, it, expect, beforeEach } from 'vitest';
import {
  UsageTracker,
  TokenBucketRateLimiter,
  LLMClient,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamChunk,
  type LLMConfig,
} from './interface.js';

// Mock LLM provider for testing
class MockLLMProvider implements LLMProvider {
  name = 'mock';
  responses: LLMResponse[] = [];
  receivedRequests: LLMRequest[] = [];
  private responseIndex = 0;
  failCount = 0;
  private failsRemaining = 0;

  constructor() {
    this.responses = [
      {
        content: 'Hello from mock!',
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ];
  }

  setFailCount(count: number): void {
    this.failCount = count;
    this.failsRemaining = count;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.receivedRequests.push(request);

    if (this.failsRemaining > 0) {
      this.failsRemaining--;
      const error = new Error('Rate limited') as Error & { status: number };
      error.status = 429;
      throw error;
    }

    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;
    return response;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    this.receivedRequests.push(request);
    yield { type: 'text', content: 'Hello' };
    yield { type: 'text', content: ' from mock!' };
    yield { type: 'done' };
  }

  supportsVision(): boolean {
    return true;
  }

  supportsToolUse(): boolean {
    return true;
  }

  maxContextTokens(): number {
    return 200000;
  }
}

describe('UsageTracker', () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker();
  });

  it('records usage per agent', () => {
    tracker.record('scout', { inputTokens: 100, outputTokens: 50, model: 'claude-haiku-4-5-20251001' });
    tracker.record('scout', { inputTokens: 200, outputTokens: 100, model: 'claude-haiku-4-5-20251001' });

    const usage = tracker.getAgentUsage('scout');
    expect(usage.totalInputTokens).toBe(300);
    expect(usage.totalOutputTokens).toBe(150);
    expect(usage.requestCount).toBe(2);
  });

  it('tracks usage by model', () => {
    tracker.record('explorer', { inputTokens: 100, outputTokens: 50, model: 'claude-haiku-4-5-20251001' });
    tracker.record('explorer', { inputTokens: 500, outputTokens: 200, model: 'claude-sonnet-4-6' });

    const usage = tracker.getAgentUsage('explorer');
    expect(usage.byModel['claude-haiku-4-5-20251001'].requests).toBe(1);
    expect(usage.byModel['claude-sonnet-4-6'].requests).toBe(1);
  });

  it('estimates cost', () => {
    tracker.record('agent1', { inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'claude-haiku-4-5-20251001' });

    const usage = tracker.getAgentUsage('agent1');
    // Haiku: $0.80/1M input + $4.00/1M output = $4.80
    expect(usage.estimatedCost).toBeCloseTo(4.8, 1);
  });

  it('aggregates session usage across agents', () => {
    tracker.record('scout', { inputTokens: 100, outputTokens: 50, model: 'claude-haiku-4-5-20251001' });
    tracker.record('explorer', { inputTokens: 500, outputTokens: 200, model: 'claude-sonnet-4-6' });

    const session = tracker.getSessionUsage();
    expect(session.totalInputTokens).toBe(600);
    expect(session.totalOutputTokens).toBe(250);
    expect(session.totalRequests).toBe(2);
    expect(Object.keys(session.byAgent)).toHaveLength(2);
  });

  it('returns empty usage for unknown agent', () => {
    const usage = tracker.getAgentUsage('unknown');
    expect(usage.totalInputTokens).toBe(0);
    expect(usage.requestCount).toBe(0);
  });

  it('resets all tracked usage', () => {
    tracker.record('scout', { inputTokens: 100, outputTokens: 50, model: 'claude-haiku-4-5-20251001' });
    tracker.reset();

    const session = tracker.getSessionUsage();
    expect(session.totalRequests).toBe(0);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('allows requests under limit', async () => {
    const limiter = new TokenBucketRateLimiter(1000); // 1000 per minute
    // Should not block
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should be near-instant
  });
});

describe('LLMClient', () => {
  let provider: MockLLMProvider;
  let client: LLMClient;
  let tracker: UsageTracker;

  const config: LLMConfig = {
    provider: 'mock',
    fastModel: 'claude-haiku-4-5-20251001',
    balancedModel: 'claude-sonnet-4-6',
    premiumModel: 'claude-opus-4-6',
    apiKey: 'test-key',
    rateLimits: { maxRequestsPerMinute: 1000, maxTokensPerMinute: 1000000 },
  };

  beforeEach(() => {
    provider = new MockLLMProvider();
    tracker = new UsageTracker();
    client = new LLMClient(provider, config, tracker);
  });

  it('completes a request and tracks usage', async () => {
    const response = await client.complete({
      systemPrompt: 'You are a test bot.',
      messages: [{ role: 'user', content: 'Hello' }],
      modelTier: 'fast',
      agentId: 'scout',
    });

    expect(response.content).toBe('Hello from mock!');

    const usage = tracker.getAgentUsage('scout');
    expect(usage.requestCount).toBe(1);
    expect(usage.totalInputTokens).toBe(100);
  });

  it('streams responses', async () => {
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of client.stream({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi' }],
      modelTier: 'balanced',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[1].content).toBe(' from mock!');
    expect(chunks[2].type).toBe('done');
  });

  it('retries on 429 errors', async () => {
    provider.setFailCount(2); // Fail twice, succeed on third

    const response = await client.complete({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi' }],
      modelTier: 'fast',
    });

    expect(response.content).toBe('Hello from mock!');
    expect(provider.receivedRequests).toHaveLength(3); // 2 fails + 1 success
  }, 15000);

  it('uses default agent id when none provided', async () => {
    await client.complete({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi' }],
      modelTier: 'fast',
    });

    const usage = tracker.getAgentUsage('default');
    expect(usage.requestCount).toBe(1);
  });
});
