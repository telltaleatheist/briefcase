/**
 * The stored analysis report (`analyses.ai_analysis`): the text the video info
 * page shows and library search reads. AIAnalysisService writes it for a run:
 *
 *   ========  VIDEO ANALYSIS RESULTS  ========
 *   **VIDEO OVERVIEW**  <description>  -----      (only when metadata ran)
 *   **HH:MM:SS - HH:MM:SS - <reason> [category]**  <quotes>  -----   (one per finding)
 *
 * A run that made only some parts (analysis-parts.ts) must not throw away the
 * report's other half, so the stored report is MERGED: the overview is the new
 * one when metadata ran and the old one otherwise; the findings are the new
 * ones when flags ran (outside a range, the old ones are kept) and the old ones
 * otherwise. Pure: no I/O.
 */

import type { AnalysisRange } from './analysis-parts';

const RULE = '-'.repeat(80);
const OVERVIEW_HEAD = '**VIDEO OVERVIEW**';

export interface ReportParts {
  /** Everything before the first block (the banner). */
  header: string;
  /** The overview block's text, without its heading; null when the report has none. */
  overview: string | null;
  /** One block per finding, as written, with the second it starts at (null when unreadable). */
  findings: Array<{ startSeconds: number | null; text: string }>;
}

function hmsToSeconds(hms: string): number {
  const parts = hms.split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

/** Split a report into its banner, overview and findings. */
export function parseAnalysisReport(text: string | null | undefined): ReportParts {
  const out: ReportParts = { header: '', overview: null, findings: [] };
  if (!text) return out;
  const blocks = text.split(`${RULE}\n\n`);
  // The banner is everything up to the first "**" block (it contains its own '=' rules, not RULE).
  const first = blocks[0];
  const bodyAt = first.indexOf('\n\n**');
  if (bodyAt === -1 && !first.startsWith('**')) {
    out.header = first;
    blocks.shift();
  } else if (bodyAt !== -1) {
    out.header = first.slice(0, bodyAt + 2);
    blocks[0] = first.slice(bodyAt + 2);
  }
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (block.startsWith(OVERVIEW_HEAD)) {
      out.overview = block.slice(OVERVIEW_HEAD.length).trim();
      continue;
    }
    const at = /^\*\*(\d{1,2}:\d{2}(?::\d{2})?)/.exec(block);
    out.findings.push({ startSeconds: at ? hmsToSeconds(at[1]) : null, text: block });
  }
  return out;
}

function composeAnalysisReport(parts: ReportParts): string {
  let text = parts.header;
  if (parts.overview) text += `${OVERVIEW_HEAD}\n\n${parts.overview}\n\n${RULE}\n\n`;
  for (const finding of parts.findings) text += `${finding.text}${RULE}\n\n`;
  return text;
}

/**
 * The report to store after a run: the run's own report for the parts it made,
 * the previous report for the rest.
 *
 *   overview  replaced when metadata ran (dropped when it produced none), else kept
 *   findings  replaced when flags ran on the whole video; with a range, only the
 *             findings that start inside it are replaced; else kept
 */
export function mergeAnalysisReport(
  previous: string | null | undefined,
  run: string,
  made: { metadata: boolean; flags: boolean; range?: AnalysisRange | null },
): string {
  const next = parseAnalysisReport(run);
  if (!previous) return run;
  const old = parseAnalysisReport(previous);
  const inRange = (s: number | null) => made.range != null && s !== null && s >= made.range.start && s < made.range.end;
  const findings = !made.flags
    ? old.findings
    : made.range
      ? [...old.findings.filter((f) => !inRange(f.startSeconds)), ...next.findings].sort(
          (a, b) => (a.startSeconds ?? 0) - (b.startSeconds ?? 0),
        )
      : next.findings;
  return composeAnalysisReport({
    header: next.header || old.header,
    overview: made.metadata ? next.overview : old.overview,
    findings,
  });
}
