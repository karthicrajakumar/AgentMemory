// Shared types used across all modules

export interface InteractiveElement {
  selector: string;
  tag: string;
  type?: string; // input type, button type, etc.
  role?: string;
  name?: string; // accessible name
  text?: string;
  href?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export interface FormField {
  selector: string;
  tag: string;
  type: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  options?: string[]; // for select elements
}

export interface LinkElement {
  selector: string;
  href: string;
  text: string;
  isExternal: boolean;
}

export interface PageMeta {
  url: string;
  title: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
}

export interface NavigationStep {
  from: string;
  to: string;
  action: string; // e.g., "click link 'Settings'"
}

export interface VirtualPage {
  id: string;
  url: string;
  fingerprint: string;
  description?: string;
}

// LLM types

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: Buffer[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Selector types

export interface SelectorEntry {
  strategy: 'aria' | 'testid' | 'css' | 'text' | 'xpath';
  value: string;
  timeout?: number; // Default: 5000ms
}

export interface SelectorChain {
  selectors: SelectorEntry[];
  totalTimeout?: number; // Default: 15000ms
}

export interface ResolvedSelector {
  strategy: string;
  value: string;
  element: unknown; // Playwright ElementHandle at runtime
}

export interface ActionResult {
  success: boolean;
  usedSelector: { strategy: string; value: string };
  error?: string;
  duration: number;
  timestamp: number;
}
