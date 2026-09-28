import { describe, expect, it } from '@jest/globals';
import { mergeAnalysisReport, parseAnalysisReport } from './analysis-report';

const RULE = '-'.repeat(80);
const BANNER = `${'='.repeat(80)}\nVIDEO ANALYSIS RESULTS\n${'='.repeat(80)}\n\n`;

/** A report as AIAnalysisService writes it. */
function report(overview: string | null, findings: Array<[string, string]>): string {
  let text = BANNER;
  if (overview) text += `**VIDEO OVERVIEW**\n\n${overview}\n\n${RULE}\n\n`;
  for (const [start, what] of findings) {
    text += `**${start} - ${start} - ${what} [hate]**\n\n${start} - "${what} said"\n\n${RULE}\n\n`;
  }
  return text;
}

describe('the stored analysis report', () => {
  it('reads back the banner, overview and findings as written', () => {
    const parsed = parseAnalysisReport(report('A video about pasta.', [['00:00:20', 'a'], ['01:00:00', 'b']]));
    expect(parsed.header).toBe(BANNER);
    expect(parsed.overview).toBe('A video about pasta.');
    expect(parsed.findings.map((f) => f.startSeconds)).toEqual([20, 3600]);
  });

  it('a whole run replaces the whole report', () => {
    const run = report('New overview.', [['00:05:00', 'new']]);
    expect(mergeAnalysisReport(report('Old.', [['00:01:00', 'old']]), run, { metadata: true, flags: true })).toBe(run);
  });

  it('flags alone keep the old overview; metadata alone keeps the old findings', () => {
    const old = report('Old overview.', [['00:01:00', 'old']]);
    expect(mergeAnalysisReport(old, report(null, [['00:05:00', 'new']]), { metadata: false, flags: true })).toBe(
      report('Old overview.', [['00:05:00', 'new']]),
    );
    expect(mergeAnalysisReport(old, report('New overview.', []), { metadata: true, flags: false })).toBe(
      report('New overview.', [['00:01:00', 'old']]),
    );
    // Chapters alone touch neither.
    expect(mergeAnalysisReport(old, report(null, []), { metadata: false, flags: false })).toBe(old);
  });

  it("one chapter's flags replace only the findings that start inside it, in time order", () => {
    const old = report('Overview.', [['00:01:00', 'before'], ['00:10:30', 'inside'], ['00:25:00', 'after']]);
    const run = report(null, [['00:12:00', 'new inside']]);
    expect(mergeAnalysisReport(old, run, { metadata: false, flags: true, range: { start: 600, end: 1200 } })).toBe(
      report('Overview.', [['00:01:00', 'before'], ['00:12:00', 'new inside'], ['00:25:00', 'after']]),
    );
  });

  it('with no previous report, the run is the report', () => {
    const run = report(null, [['00:05:00', 'new']]);
    expect(mergeAnalysisReport(null, run, { metadata: false, flags: true })).toBe(run);
  });
});
