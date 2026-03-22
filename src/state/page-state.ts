import { writeFile, readFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type {
  InteractiveElement,
  FormField,
  LinkElement,
  NavigationStep,
  VirtualPage,
} from '../types/index.js';

export interface PageState {
  url: string;
  title: string;
  fingerprint: string;
  virtualPageId?: string;
}

export interface PageKnowledge {
  elements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
  authGated: boolean;
  lastVisited: string;
  notes: string;
}

const DEFAULT_STATE_PATH = '.replaybot/state.json';

interface SerializedState {
  currentPage: PageState | null;
  targetPage: string | null;
  knowledge: Record<string, PageKnowledge>;
  fingerprints: Record<string, VirtualPage>;
  navigationGraph: Record<string, string[]>; // from URL -> [to URLs]
}

export class PageStateManager {
  private currentPageState: PageState | null = null;
  private targetPageUrl: string | null = null;
  private knowledge = new Map<string, PageKnowledge>();
  private fingerprints = new Map<string, VirtualPage>();
  private navigationGraph = new Map<string, Set<string>>();
  private statePath: string;

  constructor(statePath?: string) {
    this.statePath = statePath ?? DEFAULT_STATE_PATH;
  }

  // Current state

  getCurrentPage(): PageState | null {
    return this.currentPageState;
  }

  setCurrentPage(state: PageState): void {
    // Track navigation edges
    if (this.currentPageState && this.currentPageState.url !== state.url) {
      const edges = this.navigationGraph.get(this.currentPageState.url) ?? new Set();
      edges.add(state.url);
      this.navigationGraph.set(this.currentPageState.url, edges);
    }

    this.currentPageState = state;
    this.persistAsync();
  }

  // Navigation awareness

  setTargetPage(url: string): void {
    this.targetPageUrl = url;
  }

  getTargetPage(): string | null {
    return this.targetPageUrl;
  }

  getPathTo(targetUrl: string): NavigationStep[] {
    // BFS through navigation graph
    if (!this.currentPageState) return [];

    const start = this.currentPageState.url;
    if (start === targetUrl) return [];

    const visited = new Set<string>([start]);
    const queue: Array<{ url: string; path: NavigationStep[] }> = [
      { url: start, path: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.navigationGraph.get(current.url);
      if (!neighbors) continue;

      for (const next of neighbors) {
        if (visited.has(next)) continue;
        visited.add(next);

        const step: NavigationStep = {
          from: current.url,
          to: next,
          action: `navigate to ${next}`,
        };
        const path = [...current.path, step];

        if (next === targetUrl) return path;
        queue.push({ url: next, path });
      }
    }

    return []; // No known path
  }

  // Knowledge base (last-write-wins)

  addPageKnowledge(url: string, knowledge: PageKnowledge): void {
    this.knowledge.set(url, {
      ...knowledge,
      lastVisited: new Date().toISOString(),
    });
    this.persistAsync();
  }

  getPageKnowledge(url: string): PageKnowledge | null {
    return this.knowledge.get(url) ?? null;
  }

  getAllKnowledge(): Map<string, PageKnowledge> {
    return new Map(this.knowledge);
  }

  // Fingerprinting (SPA support)

  registerFingerprint(fingerprint: string, virtualPage: VirtualPage): void {
    this.fingerprints.set(fingerprint, virtualPage);
    this.persistAsync();
  }

  lookupFingerprint(fingerprint: string): VirtualPage | null {
    return this.fingerprints.get(fingerprint) ?? null;
  }

  // Persistence

  async save(path?: string): Promise<void> {
    const filePath = path ?? this.statePath;
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    const data: SerializedState = {
      currentPage: this.currentPageState,
      targetPage: this.targetPageUrl,
      knowledge: Object.fromEntries(this.knowledge),
      fingerprints: Object.fromEntries(this.fingerprints),
      navigationGraph: Object.fromEntries(
        Array.from(this.navigationGraph.entries()).map(([k, v]) => [k, Array.from(v)]),
      ),
    };

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async load(path?: string): Promise<void> {
    const filePath = path ?? this.statePath;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data: SerializedState = JSON.parse(raw);

      this.currentPageState = data.currentPage;
      this.targetPageUrl = data.targetPage;
      this.knowledge = new Map(Object.entries(data.knowledge));
      this.fingerprints = new Map(Object.entries(data.fingerprints));
      this.navigationGraph = new Map(
        Object.entries(data.navigationGraph).map(([k, v]) => [k, new Set(v)]),
      );
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  // Fire-and-forget persist on each mutation
  private persistAsync(): void {
    this.save().catch(() => {
      // Silently ignore persist errors — best-effort
    });
  }
}
