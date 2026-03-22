import type { ReplayResult, SelfHealReport } from '../agents/replay.js';

// ── Types ──────────────────────────────────────────────────────

export interface MCPSummary {
  structured: MCPStructuredSummary;
  narrative: string;
}

export interface MCPStructuredSummary {
  status: string;
  duration: string;
  actions: { total: number; passed: number; failed: number; selfHealed: number };
  assertions: { total: number; passed: number; failed: number };
  selfHealing: { count: number; requiresReview: boolean };
  errors: string[];
}

// ── Report Generator ───────────────────────────────────────────

export class ReportGenerator {
  /**
   * Full JSON report — machine-readable, all details.
   */
  toJSON(result: ReplayResult): string {
    return JSON.stringify(result, null, 2);
  }

  /**
   * Markdown report — human-readable, for PR comments or documentation.
   */
  toMarkdown(result: ReplayResult): string {
    const lines: string[] = [];

    // Header
    const statusEmoji = result.status === 'passed' ? '✅' : result.status === 'self_healed' ? '🔧' : '❌';
    lines.push(`## ${statusEmoji} Replay Result: ${result.status.toUpperCase()}`);
    lines.push('');

    // Summary table
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Status | **${result.status}** |`);
    lines.push(`| Duration | ${this.formatDuration(result.durationMs)} |`);
    lines.push(`| Actions | ${result.summary.passedActions}/${result.summary.totalActions} passed |`);
    lines.push(`| Assertions | ${result.summary.passedAssertions}/${result.summary.totalAssertions} passed |`);
    if (result.summary.selfHealedActions > 0) {
      lines.push(`| Self-healed | ${result.summary.selfHealedActions} actions |`);
    }
    lines.push('');

    // Failed actions
    const failedActions = result.actionResults.filter((r) => r.status === 'failed');
    if (failedActions.length > 0) {
      lines.push('### Failed Actions');
      lines.push('');
      for (const action of failedActions) {
        lines.push(`- **${action.actionId}**: ${action.error ?? 'Unknown error'}`);
        if (action.screenshotPath) {
          lines.push(`  - Screenshot: \`${action.screenshotPath}\``);
        }
      }
      lines.push('');
    }

    // Failed assertions
    const failedAssertions = result.assertionResults.filter((r) => !r.pass);
    if (failedAssertions.length > 0) {
      lines.push('### Failed Assertions');
      lines.push('');
      for (const assertion of failedAssertions) {
        lines.push(`- **${assertion.description}** (${assertion.type})`);
        if (assertion.expected) lines.push(`  - Expected: \`${assertion.expected}\``);
        if (assertion.actual) lines.push(`  - Actual: \`${assertion.actual}\``);
        lines.push(`  - ${assertion.message}`);
      }
      lines.push('');
    }

    // Self-healing report
    if (result.selfHealedActions.length > 0) {
      lines.push('### Self-Healing Report');
      lines.push('');
      lines.push('> ⚠️ These changes require human review before being accepted.');
      lines.push('');
      for (const heal of result.selfHealedActions) {
        const originalSels = heal.originalSelectors.selectors
          .map((s) => `${s.strategy}="${s.value}"`)
          .join(', ');
        lines.push(`- **${heal.actionId}**`);
        lines.push(`  - Original: \`${originalSels}\``);
        lines.push(`  - Healed: \`${heal.healedSelector.strategy}="${heal.healedSelector.value}"\``);
        lines.push(`  - Confidence: ${Math.round(heal.confidence * 100)}%`);
        lines.push(`  - Reasoning: ${heal.reasoning}`);
      }
      lines.push('');
    }

    // Artifacts
    if (result.screenshots.length > 0 || result.tracePath) {
      lines.push('### Artifacts');
      lines.push('');
      if (result.tracePath) {
        lines.push(`- Trace: \`${result.tracePath}\``);
      }
      if (result.screenshots.length > 0) {
        lines.push(`- Screenshots: ${result.screenshots.length} captured`);
        for (const ss of result.screenshots.slice(0, 5)) {
          lines.push(`  - \`${ss.path}\``);
        }
        if (result.screenshots.length > 5) {
          lines.push(`  - ...and ${result.screenshots.length - 5} more`);
        }
      }
      lines.push('');
    }

    // Timing
    lines.push('---');
    lines.push(`*Started: ${result.startedAt} | Finished: ${result.finishedAt}*`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * MCP summary — both structured JSON and natural language narrative.
   * Designed for AI assistant consumption.
   */
  toMCPSummary(result: ReplayResult): MCPSummary {
    // Structured
    const errors = result.actionResults
      .filter((r) => r.status === 'failed')
      .map((r) => `${r.actionId}: ${r.error ?? 'unknown error'}`);

    const structured: MCPStructuredSummary = {
      status: result.status,
      duration: this.formatDuration(result.durationMs),
      actions: {
        total: result.summary.totalActions,
        passed: result.summary.passedActions,
        failed: result.summary.failedActions,
        selfHealed: result.summary.selfHealedActions,
      },
      assertions: {
        total: result.summary.totalAssertions,
        passed: result.summary.passedAssertions,
        failed: result.summary.failedAssertions,
      },
      selfHealing: {
        count: result.selfHealedActions.length,
        requiresReview: result.selfHealedActions.length > 0,
      },
      errors,
    };

    // Narrative
    const narrative = this.buildNarrative(result);

    return { structured, narrative };
  }

  /**
   * Self-healing report — detailed analysis of all healed selectors.
   */
  toHealingReport(result: ReplayResult): string {
    if (result.selfHealedActions.length === 0) {
      return 'No self-healing was needed during this replay.';
    }

    const lines: string[] = [];
    lines.push('# Self-Healing Report');
    lines.push('');
    lines.push(`${result.selfHealedActions.length} action(s) required self-healing during replay.`);
    lines.push('**All changes require human review.**');
    lines.push('');

    for (const heal of result.selfHealedActions) {
      lines.push(`## Action: ${heal.actionId}`);
      lines.push('');
      lines.push('**Original selectors:**');
      for (const sel of heal.originalSelectors.selectors) {
        lines.push(`- \`${sel.strategy}="${sel.value}"\``);
      }
      lines.push('');
      lines.push(`**Healed selector:** \`${heal.healedSelector.strategy}="${heal.healedSelector.value}"\``);
      lines.push(`**Confidence:** ${Math.round(heal.confidence * 100)}%`);
      lines.push(`**Reasoning:** ${heal.reasoning}`);
      lines.push('');

      if (heal.confidence < 0.7) {
        lines.push('> ⚠️ Low confidence — manual verification strongly recommended.');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('To accept these changes, update the recording selectors with the healed values.');
    lines.push('To reject, the original selectors will be used on the next replay (and will likely fail again).');

    return lines.join('\n');
  }

  // ── Helpers ──

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  private buildNarrative(result: ReplayResult): string {
    const parts: string[] = [];

    // Overall status
    if (result.status === 'passed') {
      parts.push(`Replay completed successfully in ${this.formatDuration(result.durationMs)}.`);
    } else if (result.status === 'self_healed') {
      parts.push(`Replay completed with self-healing in ${this.formatDuration(result.durationMs)}.`);
    } else {
      parts.push(`Replay failed after ${this.formatDuration(result.durationMs)}.`);
    }

    // Action summary
    parts.push(`${result.summary.passedActions} of ${result.summary.totalActions} actions passed.`);

    // Failures
    const failedActions = result.actionResults.filter((r) => r.status === 'failed');
    if (failedActions.length > 0) {
      parts.push(`${failedActions.length} action(s) failed:`);
      for (const action of failedActions.slice(0, 3)) {
        parts.push(`  - ${action.actionId}: ${action.error ?? 'unknown'}`);
      }
      if (failedActions.length > 3) {
        parts.push(`  - ...and ${failedActions.length - 3} more`);
      }
    }

    // Assertions
    if (result.summary.totalAssertions > 0) {
      parts.push(`${result.summary.passedAssertions} of ${result.summary.totalAssertions} assertions passed.`);
    }

    // Self-healing
    if (result.selfHealedActions.length > 0) {
      parts.push(`${result.selfHealedActions.length} selector(s) were auto-healed and need human review.`);
    }

    return parts.join(' ');
  }
}
