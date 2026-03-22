import { type Page } from 'playwright';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareOptions {
  threshold?: number;          // Per-pixel color diff threshold (0-1). Default: 0.1
  diffThreshold?: number;      // Acceptable diff percentage. Default: 0.1
  ignoreRegions?: BoundingBox[];
  antialiasing?: boolean;      // Ignore antialiasing diffs. Default: true
}

export interface VisualDiff {
  pass: boolean;
  diffPercent: number;
  diffPixelCount: number;
  totalPixels: number;
  diffImagePath: string;
  baselinePath: string;
  actualPath: string;
}

const DEFAULT_BASELINES_DIR = '.replaybot/baselines';
const DEFAULT_DIFFS_DIR = '.replaybot/diffs';

/**
 * Visual regression testing using pixelmatch.
 * Baselines auto-capture on first run (Jest snapshot style).
 */
export class VisualAssertionEngine {
  private baselinesDir: string;
  private diffsDir: string;
  private defaultThreshold: number;

  constructor(baselinesDir?: string, diffsDir?: string) {
    this.baselinesDir = baselinesDir ?? DEFAULT_BASELINES_DIR;
    this.diffsDir = diffsDir ?? DEFAULT_DIFFS_DIR;
    this.defaultThreshold = 0.1; // 0.1% diff allowed
  }

  /**
   * Capture a baseline screenshot. Overwrites existing baseline.
   */
  async captureBaseline(
    page: Page,
    name: string,
    region?: BoundingBox,
  ): Promise<string> {
    await mkdir(this.baselinesDir, { recursive: true });

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filepath = join(this.baselinesDir, `${safeName}.png`);

    const screenshotOptions: {
      type: 'png';
      clip?: { x: number; y: number; width: number; height: number };
    } = { type: 'png' };

    if (region) {
      screenshotOptions.clip = region;
    }

    const buffer = await page.screenshot(screenshotOptions);
    await writeFile(filepath, buffer);
    return filepath;
  }

  /**
   * Compare current page to a saved baseline.
   * If no baseline exists, captures one and returns a passing result (first run).
   */
  async compareToBaseline(
    page: Page,
    name: string,
    options?: CompareOptions,
  ): Promise<VisualDiff> {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const baselinePath = join(this.baselinesDir, `${safeName}.png`);
    const threshold = options?.threshold ?? 0.1;
    const diffThreshold = options?.diffThreshold ?? this.defaultThreshold;
    const antialiasing = options?.antialiasing ?? true;

    // Check if baseline exists
    let baselineBuffer: Buffer;
    try {
      baselineBuffer = await readFile(baselinePath);
    } catch {
      // First run — capture baseline and pass
      const path = await this.captureBaseline(page, name);
      return {
        pass: true,
        diffPercent: 0,
        diffPixelCount: 0,
        totalPixels: 0,
        diffImagePath: '',
        baselinePath: path,
        actualPath: path,
      };
    }

    // Take current screenshot
    const actualBuffer = await page.screenshot({ type: 'png' });

    // Decode PNGs
    const baseline = PNG.sync.read(baselineBuffer);
    const actual = PNG.sync.read(Buffer.from(actualBuffer));

    // Ensure same dimensions
    if (baseline.width !== actual.width || baseline.height !== actual.height) {
      // Size mismatch — auto-fail
      await mkdir(this.diffsDir, { recursive: true });
      const actualPath = join(this.diffsDir, `${safeName}-actual.png`);
      await writeFile(actualPath, actualBuffer);

      return {
        pass: false,
        diffPercent: 100,
        diffPixelCount: baseline.width * baseline.height,
        totalPixels: baseline.width * baseline.height,
        diffImagePath: '',
        baselinePath,
        actualPath,
      };
    }

    // Apply ignore regions (mask them in both images)
    if (options?.ignoreRegions) {
      for (const region of options.ignoreRegions) {
        this.maskRegion(baseline, region);
        this.maskRegion(actual, region);
      }
    }

    // Create diff image
    const diff = new PNG({ width: baseline.width, height: baseline.height });
    const totalPixels = baseline.width * baseline.height;

    const diffPixelCount = pixelmatch(
      baseline.data,
      actual.data,
      diff.data,
      baseline.width,
      baseline.height,
      {
        threshold,
        includeAA: !antialiasing,
      },
    );

    const diffPercent = (diffPixelCount / totalPixels) * 100;
    const pass = diffPercent <= diffThreshold;

    // Save diff and actual images
    await mkdir(this.diffsDir, { recursive: true });
    const diffImagePath = join(this.diffsDir, `${safeName}-diff.png`);
    const actualPath = join(this.diffsDir, `${safeName}-actual.png`);

    await writeFile(diffImagePath, PNG.sync.write(diff));
    await writeFile(actualPath, actualBuffer);

    return {
      pass,
      diffPercent: Math.round(diffPercent * 1000) / 1000,
      diffPixelCount,
      totalPixels,
      diffImagePath,
      baselinePath,
      actualPath,
    };
  }

  /**
   * Update the diff threshold (acceptable pixel diff percentage).
   */
  setThreshold(percent: number): void {
    this.defaultThreshold = percent;
  }

  /**
   * Update baseline to match current page state.
   */
  async updateBaseline(page: Page, name: string, region?: BoundingBox): Promise<string> {
    return this.captureBaseline(page, name, region);
  }

  /**
   * Mask a region in an image (fill with magenta so pixelmatch ignores it).
   */
  private maskRegion(image: PNG, region: BoundingBox): void {
    for (let y = region.y; y < region.y + region.height && y < image.height; y++) {
      for (let x = region.x; x < region.x + region.width && x < image.width; x++) {
        const idx = (y * image.width + x) * 4;
        image.data[idx] = 255;     // R
        image.data[idx + 1] = 0;   // G
        image.data[idx + 2] = 255; // B
        image.data[idx + 3] = 255; // A
      }
    }
  }
}
