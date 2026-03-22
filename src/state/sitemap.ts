import { writeFile, readFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type {
  InteractiveElement,
  FormField,
  LinkElement,
  VirtualPage,
} from '../types/index.js';

export interface SiteMapPage {
  url: string;
  title: string;
  fingerprint: string;
  pageType?: string;
  description?: string;
  isAuthGated: boolean;
  authType?: 'login_form' | 'oauth_redirect' | 'basic_auth' | 'unknown';
  interactiveElements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
  screenshotPath?: string;
  lastVisited: string;
  depth: number; // clicks from entry page
  deepAnalysis?: DeepPageAnalysis;
  virtualPages?: VirtualPage[];
}

export interface DeepPageAnalysis {
  pageType: string;
  purpose: string;
  interactionMap: InteractionMapEntry[];
  formAnalyses: FormAnalysis[];
  dynamicRegions: DynamicRegion[];
  suggestedTestScenarios: string[];
  analyzedAt: string;
}

export interface InteractionMapEntry {
  elementSelector: string;
  elementDescription: string;
  expectedOutcome: string;
  sideEffects: string[];
  stateChanges: string[];
}

export interface FormAnalysis {
  selector: string;
  purpose: string;
  fields: FormFieldAnalysis[];
  submitButtonSelector: string;
  expectedSuccessIndicator: string;
  expectedErrorIndicator: string;
}

export interface FormFieldAnalysis {
  name: string;
  type: string;
  required: boolean;
  validationRules: string[];
  selector: string;
  suggestedTestValues: {
    valid: string;
    invalid: string[];
  };
}

export interface DynamicRegion {
  description: string;
  triggerAction: string;
  triggerSelector: string;
  resultFingerprint: string;
}

export interface SiteMapEdge {
  from: string;
  to: string;
  action: string; // e.g., "click link 'About'"
  selector?: string;
}

export interface SiteMap {
  entryUrl: string;
  pages: Map<string, SiteMapPage>;
  edges: SiteMapEdge[];
  createdAt: string;
  updatedAt: string;
}

interface SerializedSiteMap {
  entryUrl: string;
  pages: Record<string, SiteMapPage>;
  edges: SiteMapEdge[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SITEMAP_PATH = '.replaybot/sitemap.json';

export class SiteMapManager {
  private sitemap: SiteMap;
  private savePath: string;

  constructor(entryUrl = '', savePath?: string) {
    this.savePath = savePath ?? DEFAULT_SITEMAP_PATH;
    this.sitemap = {
      entryUrl,
      pages: new Map(),
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  getSiteMap(): SiteMap {
    return this.sitemap;
  }

  addPage(page: SiteMapPage): void {
    this.sitemap.pages.set(page.url, page);
    this.sitemap.updatedAt = new Date().toISOString();
    this.persistAsync();
  }

  addEdge(edge: SiteMapEdge): void {
    // Avoid duplicate edges
    const exists = this.sitemap.edges.some(
      (e) => e.from === edge.from && e.to === edge.to && e.action === edge.action,
    );
    if (!exists) {
      this.sitemap.edges.push(edge);
      this.sitemap.updatedAt = new Date().toISOString();
      this.persistAsync();
    }
  }

  updatePage(url: string, updates: Partial<SiteMapPage>): void {
    const page = this.sitemap.pages.get(url);
    if (page) {
      Object.assign(page, updates);
      this.sitemap.updatedAt = new Date().toISOString();
      this.persistAsync();
    }
  }

  getPage(url: string): SiteMapPage | null {
    return this.sitemap.pages.get(url) ?? null;
  }

  findPath(from: string, to: string): SiteMapEdge[] {
    // BFS through edge graph
    if (from === to) return [];

    const visited = new Set<string>([from]);
    const queue: Array<{ url: string; path: SiteMapEdge[] }> = [{ url: from, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const outEdges = this.sitemap.edges.filter((e) => e.from === current.url);

      for (const edge of outEdges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);

        const path = [...current.path, edge];
        if (edge.to === to) return path;
        queue.push({ url: edge.to, path });
      }
    }

    return []; // No path found
  }

  getUnvisitedPages(): string[] {
    // Pages referenced in edges but not in pages map
    const knownUrls = new Set(this.sitemap.pages.keys());
    const referencedUrls = new Set<string>();

    for (const edge of this.sitemap.edges) {
      referencedUrls.add(edge.to);
    }

    return [...referencedUrls].filter((url) => !knownUrls.has(url));
  }

  getAuthGatedPages(): SiteMapPage[] {
    return [...this.sitemap.pages.values()].filter((p) => p.isAuthGated);
  }

  getPagesWithForms(): SiteMapPage[] {
    return [...this.sitemap.pages.values()].filter((p) => p.forms.length > 0);
  }

  getPagesWithInteractiveElements(): SiteMapPage[] {
    return [...this.sitemap.pages.values()].filter((p) => p.interactiveElements.length > 0);
  }

  getPageCount(): number {
    return this.sitemap.pages.size;
  }

  hasPage(url: string): boolean {
    return this.sitemap.pages.has(url);
  }

  // SPA support

  addVirtualPage(parentUrl: string, virtualPage: VirtualPage): void {
    const page = this.sitemap.pages.get(parentUrl);
    if (page) {
      if (!page.virtualPages) page.virtualPages = [];
      page.virtualPages.push(virtualPage);
      this.sitemap.updatedAt = new Date().toISOString();
      this.persistAsync();
    }
  }

  getVirtualPages(url: string): VirtualPage[] {
    return this.sitemap.pages.get(url)?.virtualPages ?? [];
  }

  // Persistence

  async save(path?: string): Promise<void> {
    const filePath = path ?? this.savePath;
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    const data: SerializedSiteMap = {
      entryUrl: this.sitemap.entryUrl,
      pages: Object.fromEntries(this.sitemap.pages),
      edges: this.sitemap.edges,
      createdAt: this.sitemap.createdAt,
      updatedAt: this.sitemap.updatedAt,
    };

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async load(path?: string): Promise<void> {
    const filePath = path ?? this.savePath;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data: SerializedSiteMap = JSON.parse(raw);

      this.sitemap = {
        entryUrl: data.entryUrl,
        pages: new Map(Object.entries(data.pages)),
        edges: data.edges,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    } catch {
      // File doesn't exist or is invalid — keep current state
    }
  }

  merge(other: SiteMap): void {
    // Union of pages, newer wins on conflicts
    for (const [url, otherPage] of other.pages) {
      const existing = this.sitemap.pages.get(url);
      if (!existing || otherPage.lastVisited > existing.lastVisited) {
        this.sitemap.pages.set(url, otherPage);
      }
    }

    // Union of edges
    for (const edge of other.edges) {
      this.addEdge(edge);
    }

    this.sitemap.updatedAt = new Date().toISOString();
    this.persistAsync();
  }

  private persistAsync(): void {
    this.save().catch(() => {
      // Best-effort
    });
  }
}
