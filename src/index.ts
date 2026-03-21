// Phase 1: Foundation — core primitives

export { BrowserController } from './browser/controller.js';
export type { LaunchOptions } from './browser/controller.js';

export { PageObserver } from './browser/observer.js';
export type {
  AccessibilityNode,
  ScreenshotOptions,
  PageObservation,
} from './browser/observer.js';

export { ActionExecutor } from './browser/actions.js';

export {
  LLMClient,
  TokenBucketRateLimiter,
  UsageTracker,
} from './llm/interface.js';
export type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  ModelTier,
  AgentUsage,
  SessionUsage,
} from './llm/interface.js';

export { PageStateManager } from './state/page-state.js';
export type { PageState, PageKnowledge } from './state/page-state.js';

export type {
  InteractiveElement,
  FormField,
  LinkElement,
  PageMeta,
  NavigationStep,
  VirtualPage,
  LLMMessage,
  ToolDefinition,
  ToolCall,
  SelectorEntry,
  SelectorChain,
  ResolvedSelector,
  ActionResult,
} from './types/index.js';
