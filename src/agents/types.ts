import type { BrowserController } from '../browser/controller.js';
import type { PageObserver } from '../browser/observer.js';
import type { ActionExecutor } from '../browser/actions.js';
import type { LLMClient } from '../llm/interface.js';
import type { PageStateManager, PageState } from '../state/page-state.js';
import type { SiteMapManager } from '../state/sitemap.js';

export interface AgentMessage {
  from: string;
  type: 'request' | 'response' | 'status' | 'auth_required';
  content: unknown;
  timestamp: string;
}

export interface AgentBudget {
  maxTokens?: number;
  maxTimeMs?: number;
}

export interface AgentContext {
  browser: BrowserController;
  observer: PageObserver;
  actions: ActionExecutor;
  llm: LLMClient;
  pageState: PageStateManager;
  sitemap: SiteMapManager;
}

export abstract class BaseAgent {
  abstract name: string;
  abstract role: string;

  protected context: AgentContext;
  protected budget: AgentBudget;
  private messageHandlers: Array<(message: AgentMessage) => Promise<AgentMessage>> = [];

  constructor(context: AgentContext, budget?: AgentBudget) {
    this.context = context;
    this.budget = budget ?? {};
  }

  getCurrentPage(): PageState | null {
    return this.context.pageState.getCurrentPage();
  }

  getTargetPage(): string | null {
    return this.context.pageState.getTargetPage();
  }

  async sendMessage(to: BaseAgent, message: Omit<AgentMessage, 'from' | 'timestamp'>): Promise<AgentMessage> {
    const fullMessage: AgentMessage = {
      ...message,
      from: this.name,
      timestamp: new Date().toISOString(),
    };

    for (const handler of to.messageHandlers) {
      const response = await handler(fullMessage);
      if (response) return response;
    }

    return {
      from: to.name,
      type: 'response',
      content: null,
      timestamp: new Date().toISOString(),
    };
  }

  onMessage(handler: (message: AgentMessage) => Promise<AgentMessage>): void {
    this.messageHandlers.push(handler);
  }

  protected checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AgentAbortError(`${this.name} was aborted`);
    }
  }

  protected async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Retry once
      try {
        return await fn();
      } catch (retryErr) {
        console.warn(`[${this.name}] ${label} failed after retry:`, retryErr);
        throw retryErr;
      }
    }
  }
}

export class AgentAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAbortError';
  }
}
