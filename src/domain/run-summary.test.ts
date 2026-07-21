import { describe, expect, it } from 'vitest';
import { buildRunSummary, credentialAgeStatus, renderRunSummaryMarkdown } from './run-summary';

/**
 * The owner's daily-review summary (DESIGN-045 D-10) — the SHAPE of the donor metrics.py
 * get_pr_summary, re-homed onto ## Changes / ## Health / ## Issues with REAL numbers. These assert
 * the sections + the numbers, not stubs (the OWNER MANDATE).
 */
describe('buildRunSummary + renderRunSummaryMarkdown', () => {
  const now = Date.parse('2026-07-20T12:00:00.000Z');
  const mintedAt = '2026-07-20T11:00:00.000Z'; // 3600s ago

  const summary = buildRunSummary({
    counts: { added: 3, removed: 0, unchanged: 1, deduped: 2, emitted: 229, skipped: 4 },
    telemetry: {
      activities: [
        {
          activity: 'Cycling',
          existing: 10,
          added: 3,
          total: 13,
          scraped: 15,
          skipped: 2,
          scrolls: 40,
          cap: 13,
        },
        {
          activity: 'Strength',
          existing: 5,
          added: 0,
          total: 5,
          scraped: 0,
          skipped: 0,
          scrolls: 0,
          cap: 25,
        },
      ],
      selectorDriftHits: 0,
      scrollsPerformed: 40,
      authOk: true,
      loginOk: true,
    },
    sessionMintedAt: mintedAt,
    credentialRefreshSec: 21600,
    now,
  });

  it('carries the REAL change numbers', () => {
    expect(summary.changes.subscriptionsAdded).toBe(3);
    expect(summary.changes.subscriptionsUnchanged).toBe(1);
    expect(summary.changes.entriesEmitted).toBe(229);
    expect(summary.changes.deduped).toBe(2);
    expect(summary.changes.skipped).toBe(4);
  });

  it('builds a per-activity breakdown with existing/added/total + cap marks', () => {
    const cycling = summary.changes.activities.find((a) => a.activity === 'Cycling');
    expect(cycling).toMatchObject({ existing: 10, added: 3, total: 13, atCap: true });
    const strength = summary.changes.activities.find((a) => a.activity === 'Strength');
    expect(strength).toMatchObject({ total: 5, atCap: false });
  });

  it('computes bearer age + credential-age status against the SLA', () => {
    expect(summary.health.bearerAgeSec).toBe(3600);
    expect(summary.health.credentialAgeStatus).toBe('ok'); // 3600s < 21600s SLA
    expect(summary.health.authOk).toBe(true);
    expect(summary.health.selectorDriftHits).toBe(0);
  });

  it('renders the three sections with real numbers and "none" issues', () => {
    const md = renderRunSummaryMarkdown(summary);
    expect(md).toContain('## Changes');
    expect(md).toContain('## Health');
    expect(md).toContain('## Issues');
    expect(md).toContain('**3 added**, 0 removed, 1 unchanged');
    expect(md).toContain('**229 entries emitted**');
    expect(md).toContain('**Cycling:** 10 existing, 3 added, 13 total');
    expect(md).toContain('- none');
  });

  it('surfaces alarms as issues when telemetry carries them', () => {
    const withIssues = buildRunSummary({
      counts: { added: 0 },
      telemetry: {
        selectorDriftActivities: ['Cycling'],
        selectorDriftHits: 1,
        bearerCaptureRetries: 2,
        loginFailures: 1,
        overCapActivities: ['Strength'],
        scrollTimeouts: ['Yoga'],
      },
    });
    expect(withIssues.issues).toContain('selector drift on Cycling');
    expect(withIssues.issues).toContain('bearer capture retried 2×');
    expect(withIssues.issues).toContain('login failed 1×');
    expect(withIssues.issues).toContain('over cap: Strength');
    expect(withIssues.issues).toContain('scroll timeout on Yoga');
    const md = renderRunSummaryMarkdown(withIssues);
    expect(md).toContain('- selector drift on Cycling');
    expect(md).not.toContain('- none');
  });

  it('degrades gracefully for a generic in_core run (counts only, no telemetry)', () => {
    const generic = buildRunSummary({ counts: { added: 5, emitted: 80 } });
    expect(generic.changes.activities).toHaveLength(0);
    expect(generic.issues).toEqual([]);
    const md = renderRunSummaryMarkdown(generic);
    expect(md).toContain('**5 added**');
    expect(md).toContain('- none');
    expect(md).not.toContain('### Activity breakdown');
  });
});

describe('credentialAgeStatus thresholds', () => {
  it('warns at 1× and errors at 2× the SLA', () => {
    expect(credentialAgeStatus(100, 21600)).toBe('ok');
    expect(credentialAgeStatus(21600, 21600)).toBe('warn');
    expect(credentialAgeStatus(43200, 21600)).toBe('error');
    expect(credentialAgeStatus(null, 21600)).toBe('unknown');
    expect(credentialAgeStatus(100, null)).toBe('unknown');
  });
});
