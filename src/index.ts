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

export { SiteMapManager } from './state/sitemap.js';
export type {
  SiteMapPage,
  SiteMapEdge,
  SiteMap,
  SharedComponent,
  DeepPageAnalysis,
  InteractionMapEntry,
  FormAnalysis,
  FormFieldAnalysis,
  DynamicRegion,
} from './state/sitemap.js';

// Phase 2: Agents — Scout, Deep Explorer, Orchestrator

export { BaseAgent, AgentAbortError, AgentBudgetExceededError } from './agents/types.js';
export type { AgentContext, AgentBudget, AgentMessage, Credentials } from './agents/types.js';

export { ScoutAgent } from './agents/scout.js';
export type { ScoutOptions, ScoutPageResult } from './agents/scout.js';

export { DeepExplorerAgent } from './agents/deep-explorer.js';
export type { DeepExploreOptions, DeepExploreResult, VerificationResult } from './agents/deep-explorer.js';

export { Orchestrator } from './agents/orchestrator.js';
export type { ExploreAppOptions, ExploreAppResult } from './agents/orchestrator.js';

// Shared types

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
