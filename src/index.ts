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

// Phase 3: Planner, Recording, Assertions

export { PlannerAgent } from './agents/planner.js';
export type {
  TestPlan,
  TestStep,
  PlannedAssertion,
  ExecutionResult,
  PlannerOptions,
} from './agents/planner.js';

export { RecordingManager } from './state/recordings.js';
export type {
  Recording,
  ActionRecord,
  AssertionRecord,
  AssertionResult,
  ParameterDef,
  ActionType,
  RecordingMetadata,
  RecordingSummary,
} from './state/recordings.js';

export { ElementAssertionEngine } from './assertions/element.js';
export { VisualAssertionEngine } from './assertions/visual.js';
export type { VisualDiff, CompareOptions, BoundingBox } from './assertions/visual.js';
export { CustomAssertionEngine } from './assertions/custom.js';
export type { CustomAssertionFn } from './assertions/custom.js';

// Phase 4: Execution, Replay, Parameterization, Reporting

export { ExecutionAgent } from './agents/execution.js';
export type {
  ExecutionPlan,
  ResolvedAction,
  ResolvedAssertion,
  ExecutionOptions,
} from './agents/execution.js';

export { ReplayAgent } from './agents/replay.js';
export type {
  ReplayOptions,
  ReplayResult,
  ReplaySummary,
  ActionReplayResult,
  AssertionReplayResult,
  SelfHealReport,
  SteppedReplay,
} from './agents/replay.js';

export { ParameterEngine } from './state/parameters.js';

export { ReportGenerator } from './reporting/generator.js';
export type { MCPSummary, MCPStructuredSummary } from './reporting/generator.js';

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
