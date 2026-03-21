import type { LLMMessage, ToolDefinition, ToolCall } from '../types/index.js';

// Model tiers
export type ModelTier = 'fast' | 'balanced' | 'premium';

export interface LLMRequest {
  systemPrompt: string;
  messages: LLMMessage[];
  images?: Buffer[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  modelTier: ModelTier;
  agentId?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMStreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | string;
  fastModel: string;
  balancedModel: string;
  premiumModel: string;
  apiKey: string;
  rateLimits?: {
    maxRequestsPerMinute: number;
    maxTokensPerMinute: number;
  };
}

// Provider interface — adapters implement this

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
  supportsVision(): boolean;
  supportsToolUse(): boolean;
  maxContextTokens(): number;
}

// Token bucket rate limiter

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60_000;
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Usage tracker — per agent, per session

export interface AgentUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  requestCount: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  totalRequests: number;
  byAgent: Record<string, AgentUsage>;
}

// Rough cost estimates per 1M tokens (USD)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};

export class UsageTracker {
  private agents: Map<string, AgentUsage> = new Map();

  record(
    agentId: string,
    usage: { inputTokens: number; outputTokens: number; model: string },
  ): void {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCost: 0,
        requestCount: 0,
        byModel: {},
      };
      this.agents.set(agentId, agent);
    }

    agent.totalInputTokens += usage.inputTokens;
    agent.totalOutputTokens += usage.outputTokens;
    agent.requestCount += 1;

    if (!agent.byModel[usage.model]) {
      agent.byModel[usage.model] = { inputTokens: 0, outputTokens: 0, requests: 0 };
    }
    agent.byModel[usage.model].inputTokens += usage.inputTokens;
    agent.byModel[usage.model].outputTokens += usage.outputTokens;
    agent.byModel[usage.model].requests += 1;

    // Estimate cost
    const costs = MODEL_COSTS[usage.model] ?? { input: 3.0, output: 15.0 };
    agent.estimatedCost +=
      (usage.inputTokens / 1_000_000) * costs.input +
      (usage.outputTokens / 1_000_000) * costs.output;
  }

  getAgentUsage(agentId: string): AgentUsage {
    return (
      this.agents.get(agentId) ?? {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCost: 0,
        requestCount: 0,
        byModel: {},
      }
    );
  }

  getSessionUsage(): SessionUsage {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let estimatedCost = 0;
    let totalRequests = 0;
    const byAgent: Record<string, AgentUsage> = {};

    for (const [agentId, agent] of this.agents) {
      totalInputTokens += agent.totalInputTokens;
      totalOutputTokens += agent.totalOutputTokens;
      estimatedCost += agent.estimatedCost;
      totalRequests += agent.requestCount;
      byAgent[agentId] = { ...agent };
    }

    return { totalInputTokens, totalOutputTokens, estimatedCost, totalRequests, byAgent };
  }

  reset(): void {
    this.agents.clear();
  }
}

// LLM client with rate limiting and retry

export class LLMClient {
  private provider: LLMProvider;
  private config: LLMConfig;
  private rateLimiter: TokenBucketRateLimiter;
  private usageTracker: UsageTracker;

  constructor(provider: LLMProvider, config: LLMConfig, usageTracker?: UsageTracker) {
    this.provider = provider;
    this.config = config;
    this.rateLimiter = new TokenBucketRateLimiter(
      config.rateLimits?.maxRequestsPerMinute ?? 60,
    );
    this.usageTracker = usageTracker ?? new UsageTracker();
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    await this.rateLimiter.acquire();

    const response = await this.withRetry(() => this.provider.complete(request));

    const model = this.resolveModel(request.modelTier);
    this.usageTracker.record(request.agentId ?? 'default', {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      model,
    });

    return response;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    await this.rateLimiter.acquire();

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of this.provider.stream(request)) {
      yield chunk;
      if (chunk.type === 'done') {
        // Final chunk may carry usage info — tracked externally
      }
    }

    // Usage tracked by caller when streaming (via the final response)
  }

  getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  private resolveModel(tier: ModelTier): string {
    switch (tier) {
      case 'fast':
        return this.config.fastModel;
      case 'balanced':
        return this.config.balancedModel;
      case 'premium':
        return this.config.premiumModel;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on rate limit (429) or server errors (5xx)
        const status = (err as { status?: number }).status;
        if (status && status !== 429 && status < 500) {
          throw lastError;
        }

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
