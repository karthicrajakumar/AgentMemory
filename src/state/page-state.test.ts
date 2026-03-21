import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PageStateManager } from './page-state.js';
import { unlink, rm } from 'fs/promises';

describe('PageStateManager', () => {
  let manager: PageStateManager;
  const testStatePath = '.replaybot-test/state.json';

  beforeEach(() => {
    manager = new PageStateManager(testStatePath);
  });

  afterEach(async () => {
    await rm('.replaybot-test', { recursive: true, force: true });
  });

  describe('current page', () => {
    it('starts with no current page', () => {
      expect(manager.getCurrentPage()).toBeNull();
    });

    it('tracks current page', () => {
      manager.setCurrentPage({ url: 'https://example.com', title: 'Example', fingerprint: 'abc123' });
      const page = manager.getCurrentPage();
      expect(page?.url).toBe('https://example.com');
      expect(page?.title).toBe('Example');
    });
  });

  describe('navigation', () => {
    it('tracks target page', () => {
      manager.setTargetPage('https://example.com/settings');
      expect(manager.getTargetPage()).toBe('https://example.com/settings');
    });

    it('builds navigation graph from page transitions', () => {
      manager.setCurrentPage({ url: 'https://example.com', title: 'Home', fingerprint: 'a' });
      manager.setCurrentPage({ url: 'https://example.com/about', title: 'About', fingerprint: 'b' });
      manager.setCurrentPage({ url: 'https://example.com/contact', title: 'Contact', fingerprint: 'c' });

      // Should find path from current page to a previously connected page
      // The graph has: / -> /about -> /contact
      // From /contact, there's no path to / since we only recorded forward edges
      const pathToAbout = manager.getPathTo('https://example.com/about');
      // /contact has no edge to /about, so path should be empty
      expect(pathToAbout).toEqual([]);
    });

    it('finds path through navigation graph', () => {
      manager.setCurrentPage({ url: 'https://example.com', title: 'Home', fingerprint: 'a' });
      manager.setCurrentPage({ url: 'https://example.com/about', title: 'About', fingerprint: 'b' });

      // Reset to home
      manager.setCurrentPage({ url: 'https://example.com', title: 'Home', fingerprint: 'a' });

      // Now from home, we should find path to /about
      const path = manager.getPathTo('https://example.com/about');
      expect(path).toHaveLength(1);
      expect(path[0].to).toBe('https://example.com/about');
    });
  });

  describe('knowledge base', () => {
    it('stores and retrieves page knowledge', () => {
      const knowledge = {
        elements: [],
        forms: [],
        links: [],
        authGated: false,
        lastVisited: new Date().toISOString(),
        notes: 'Home page with login form',
      };

      manager.addPageKnowledge('https://example.com', knowledge);
      const retrieved = manager.getPageKnowledge('https://example.com');
      expect(retrieved).toBeTruthy();
      expect(retrieved?.notes).toBe('Home page with login form');
    });

    it('returns null for unknown pages', () => {
      expect(manager.getPageKnowledge('https://unknown.com')).toBeNull();
    });

    it('overwrites existing knowledge (last-write-wins)', () => {
      manager.addPageKnowledge('https://example.com', {
        elements: [],
        forms: [],
        links: [],
        authGated: false,
        lastVisited: new Date().toISOString(),
        notes: 'Version 1',
      });

      manager.addPageKnowledge('https://example.com', {
        elements: [],
        forms: [],
        links: [],
        authGated: true,
        lastVisited: new Date().toISOString(),
        notes: 'Version 2',
      });

      const knowledge = manager.getPageKnowledge('https://example.com');
      expect(knowledge?.notes).toBe('Version 2');
      expect(knowledge?.authGated).toBe(true);
    });

    it('returns all knowledge', () => {
      manager.addPageKnowledge('https://a.com', {
        elements: [], forms: [], links: [], authGated: false,
        lastVisited: '', notes: 'A',
      });
      manager.addPageKnowledge('https://b.com', {
        elements: [], forms: [], links: [], authGated: false,
        lastVisited: '', notes: 'B',
      });

      const all = manager.getAllKnowledge();
      expect(all.size).toBe(2);
    });
  });

  describe('fingerprints', () => {
    it('registers and looks up fingerprints', () => {
      const virtualPage = {
        id: 'vp1',
        url: 'https://example.com',
        fingerprint: 'abc123',
        description: 'Dashboard view',
      };

      manager.registerFingerprint('abc123', virtualPage);
      const result = manager.lookupFingerprint('abc123');
      expect(result?.id).toBe('vp1');
      expect(result?.description).toBe('Dashboard view');
    });

    it('returns null for unknown fingerprints', () => {
      expect(manager.lookupFingerprint('unknown')).toBeNull();
    });
  });

  describe('persistence', () => {
    it('saves and loads state', async () => {
      manager.setCurrentPage({ url: 'https://example.com', title: 'Test', fingerprint: 'fp1' });
      manager.addPageKnowledge('https://example.com', {
        elements: [], forms: [], links: [],
        authGated: false, lastVisited: '', notes: 'Test page',
      });
      manager.registerFingerprint('fp1', {
        id: 'vp1', url: 'https://example.com', fingerprint: 'fp1',
      });

      await manager.save();

      // Load into a new manager
      const manager2 = new PageStateManager(testStatePath);
      await manager2.load();

      expect(manager2.getCurrentPage()?.url).toBe('https://example.com');
      expect(manager2.getPageKnowledge('https://example.com')?.notes).toBe('Test page');
      expect(manager2.lookupFingerprint('fp1')?.id).toBe('vp1');
    });

    it('handles missing state file gracefully', async () => {
      const manager2 = new PageStateManager('.replaybot-test/nonexistent.json');
      await manager2.load(); // Should not throw
      expect(manager2.getCurrentPage()).toBeNull();
    });
  });
});
