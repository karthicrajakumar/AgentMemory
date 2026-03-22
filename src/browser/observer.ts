import { type Page } from 'playwright';
import { createHash } from 'crypto';
import type {
  InteractiveElement,
  FormField,
  LinkElement,
  PageMeta,
} from '../types/index.js';

export interface AccessibilityNode {
  role: string;
  name: string;
  children: AccessibilityNode[];
  properties?: Record<string, string>;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
}

export interface PageObservation {
  url: string;
  title: string;
  fingerprint: string;
  accessibilityTree: AccessibilityNode;
  simplifiedDOM: string;
  screenshot: Buffer;
  interactiveElements: InteractiveElement[];
  forms: FormField[];
  links: LinkElement[];
}

export class PageObserver {
  async getAccessibilityTree(page: Page): Promise<AccessibilityNode> {
    // Use Playwright's ariaSnapshot for accessibility tree
    const snapshot = await page.locator('body').ariaSnapshot();

    // Parse the YAML-like aria snapshot into our tree format
    return this.parseAriaSnapshot(snapshot);
  }

  async getSimplifiedDOM(page: Page): Promise<string> {
    return page.evaluate(() => {
      const SEMANTIC_TAGS = new Set([
        'html', 'head', 'title', 'body',
        'header', 'nav', 'main', 'footer', 'aside', 'section', 'article',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'a', 'button', 'input', 'textarea', 'select', 'option', 'label',
        'form', 'fieldset', 'legend',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'dialog', 'details', 'summary',
        'img', 'figure', 'figcaption',
        'span', 'div',
      ]);

      const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'link', 'meta']);

      const isHidden = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        return (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          el.getAttribute('aria-hidden') === 'true'
        );
      };

      const hasSemantic = (el: Element): boolean => {
        return !!(
          el.getAttribute('role') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('data-testid') ||
          el.id
        );
      };

      const simplify = (node: Node, depth: number): string => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim();
          return text ? text : '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        if (SKIP_TAGS.has(tag)) return '';
        if (isHidden(el)) return '';

        // For div/span, only keep if they have semantic attributes
        if ((tag === 'div' || tag === 'span') && !hasSemantic(el)) {
          return Array.from(el.childNodes)
            .map((child) => simplify(child, depth))
            .filter(Boolean)
            .join('\n');
        }

        if (!SEMANTIC_TAGS.has(tag) && !hasSemantic(el)) {
          return Array.from(el.childNodes)
            .map((child) => simplify(child, depth))
            .filter(Boolean)
            .join('\n');
        }

        const indent = '  '.repeat(depth);
        const attrs: string[] = [];

        for (const attr of ['id', 'role', 'aria-label', 'type', 'name', 'href', 'data-testid', 'placeholder', 'for']) {
          const val = el.getAttribute(attr);
          if (val) attrs.push(`${attr}="${val}"`);
        }

        const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
        const children = Array.from(el.childNodes)
          .map((child) => simplify(child, depth + 1))
          .filter(Boolean)
          .join('\n');

        if (!children) {
          return `${indent}<${tag}${attrStr}/>`;
        }

        if (!children.includes('\n') && children.length < 80) {
          return `${indent}<${tag}${attrStr}>${children}</${tag}>`;
        }

        return `${indent}<${tag}${attrStr}>\n${children}\n${indent}</${tag}>`;
      }

      return simplify(document.documentElement, 0);
    });
  }

  async takeScreenshot(page: Page, options?: ScreenshotOptions): Promise<Buffer> {
    const buffer = await page.screenshot({
      fullPage: options?.fullPage ?? false,
      type: 'png',
    });
    return Buffer.from(buffer);
  }

  async getPageFingerprint(page: Page): Promise<string> {
    const tagStructure = await page.evaluate(() => {
      const extractStructure = (node: Node): string => {
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'svg', 'noscript'].includes(tag)) return '';
        const children = Array.from(el.childNodes)
          .map(extractStructure)
          .filter(Boolean)
          .join(',');
        return children ? `${tag}(${children})` : tag;
      }
      return extractStructure(document.documentElement);
    });

    return createHash('sha256').update(tagStructure).digest('hex').slice(0, 16);
  }

  async getPageMetadata(page: Page): Promise<PageMeta> {
    return page.evaluate(() => {
      const getMeta = (name: string) =>
        document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)
          ?.getAttribute('content') ?? undefined;

      return {
        url: window.location.href,
        title: document.title,
        description: getMeta('description'),
        canonical:
          document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined,
        ogImage: getMeta('og:image'),
      };
    });
  }

  async getInteractiveElements(page: Page): Promise<InteractiveElement[]> {
    return page.evaluate(() => {
      const elements: InteractiveElement[] = [];
      const interactiveSelectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';

      for (const el of document.querySelectorAll(interactiveSelectors)) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null && htmlEl.tagName !== 'INPUT') continue;

        let selector = '';
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.getAttribute('data-testid')) {
          selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        } else if (el.getAttribute('aria-label')) {
          selector = `[aria-label="${el.getAttribute('aria-label')}"]`;
        } else {
          const tag = el.tagName.toLowerCase();
          const siblings = el.parentElement?.querySelectorAll(tag);
          const index = siblings ? Array.from(siblings).indexOf(el) + 1 : 1;
          selector = `${tag}:nth-of-type(${index})`;
        }

        elements.push({
          selector,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? undefined,
          role: el.getAttribute('role') ?? undefined,
          name: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? undefined,
          text: htmlEl.innerText?.trim().slice(0, 100) || undefined,
          href: el.getAttribute('href') ?? undefined,
          disabled: (el as HTMLButtonElement).disabled ?? false,
          ariaLabel: el.getAttribute('aria-label') ?? undefined,
        });
      }

      return elements;
    });
  }

  async getFormFields(page: Page): Promise<FormField[]> {
    return page.evaluate(() => {
      const fields: FormField[] = [];

      for (const el of document.querySelectorAll('input, textarea, select')) {
        const htmlEl = el as HTMLInputElement;

        let label: string | undefined;
        if (htmlEl.id) {
          label = document.querySelector(`label[for="${htmlEl.id}"]`)?.textContent?.trim();
        }
        if (!label) {
          label = htmlEl.closest('label')?.textContent?.trim();
        }

        let selector = '';
        if (el.id) selector = `#${el.id}`;
        else if (el.getAttribute('name')) selector = `[name="${el.getAttribute('name')}"]`;
        else if (el.getAttribute('data-testid'))
          selector = `[data-testid="${el.getAttribute('data-testid')}"]`;

        const field: FormField = {
          selector,
          tag: el.tagName.toLowerCase(),
          type: htmlEl.type || 'text',
          name: htmlEl.name || undefined,
          label,
          placeholder: htmlEl.placeholder || undefined,
          value: htmlEl.value || undefined,
          required: htmlEl.required,
        };

        if (el.tagName === 'SELECT') {
          field.options = Array.from((el as HTMLSelectElement).options).map((o) => o.text);
        }

        fields.push(field);
      }

      return fields;
    });
  }

  async getLinks(page: Page): Promise<LinkElement[]> {
    return page.evaluate(() => {
      const links: LinkElement[] = [];
      const origin = window.location.origin;

      for (const el of document.querySelectorAll('a[href]')) {
        const href = el.getAttribute('href');
        if (!href) continue;

        let selector = '';
        if (el.id) selector = `#${el.id}`;
        else if (el.getAttribute('data-testid'))
          selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        else selector = `a[href="${href}"]`;

        let isExternal = false;
        try {
          const url = new URL(href, window.location.href);
          isExternal = url.origin !== origin;
        } catch {
          // relative URL, not external
        }

        links.push({
          selector,
          href,
          text: (el as HTMLElement).innerText?.trim().slice(0, 200) || '',
          isExternal,
        });
      }

      return links;
    });
  }

  async observe(page: Page): Promise<PageObservation> {
    const [
      accessibilityTree,
      simplifiedDOM,
      screenshot,
      fingerprint,
      interactiveElements,
      forms,
      links,
    ] = await Promise.all([
      this.getAccessibilityTree(page),
      this.getSimplifiedDOM(page),
      this.takeScreenshot(page),
      this.getPageFingerprint(page),
      this.getInteractiveElements(page),
      this.getFormFields(page),
      this.getLinks(page),
    ]);

    return {
      url: page.url(),
      title: await page.title(),
      fingerprint,
      accessibilityTree,
      simplifiedDOM,
      screenshot,
      interactiveElements,
      forms,
      links,
    };
  }

  // Parse Playwright's ariaSnapshot YAML-like output into our tree format
  private parseAriaSnapshot(snapshot: string): AccessibilityNode {
    const root: AccessibilityNode = { role: 'document', name: '', children: [] };
    if (!snapshot.trim()) return root;

    const lines = snapshot.split('\n');
    const stack: Array<{ node: AccessibilityNode; indent: number }> = [
      { node: root, indent: -1 },
    ];

    for (const line of lines) {
      if (!line.trim()) continue;

      const indent = line.search(/\S/);
      const content = line.trim();

      // Parse "- role \"name\"" or "- role" or "- text content"
      const match = content.match(/^-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+\[(.+)\])?/);
      if (!match) continue;

      const role = match[1];
      const name = match[2] ?? '';

      const node: AccessibilityNode = { role, name, children: [] };

      // Find parent based on indentation
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, indent });
    }

    return root;
  }
}
