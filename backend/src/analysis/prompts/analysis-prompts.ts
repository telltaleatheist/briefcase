/**
 * AI Analysis Prompts and Categories for Briefcase Video Analysis
 *
 * This file contains all prompts and default categories used by the AI analysis system.
 * Edit this file to modify prompts or default categories.
 *
 * Categories are saved to user's config file on first run and can be edited in Settings.
 * Prompts are code-only and require rebuilding to change.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface AnalysisCategory {
  name: string;
  description?: string;
  enabled?: boolean;
}

// =============================================================================
// DEFAULT ANALYSIS CATEGORIES
// =============================================================================
// These are written to the user's config file on first run.
// Users can customize them in Settings > Analysis Categories.

export const DEFAULT_CATEGORIES: AnalysisCategory[] = [
  {
    name: 'hate',
    description: 'ANY use of slurs (f-slur, n-word, etc.) - flag even if "quoted", attributed to others, or presented as etymology/translation. Discrimination, dehumanization, or hostility toward minority groups (LGBTQ+, racial, religious, ethnic, immigrants). Anti-gay or anti-minority rhetoric regardless of "biblical", "historical", or "educational" framing.',
  },
  {
    name: 'conspiracy',
    description: 'Content that PROMOTES conspiracy theories as true (election fraud, deep state, QAnon, globalists, voter fraud, "stolen election", New World Order, Illuminati, Freemasons, Soros conspiracies, alien/UFO claims presented as fact). NOTE: Do NOT flag content that REPORTS ON, ANALYZES, or DEBUNKS conspiracy theories - only flag content that promotes them as true.',
  },
  {
    name: 'false-prophecy',
    description: 'ANY claims of divine communication or prophecy (God speaking to them, prophetic declarations, divine revelations, "God told me", supernatural knowledge claims, prophecies about political/world events)',
  },
  {
    name: 'misinformation',
    description: 'Factually incorrect claims PROMOTED as true about science, medicine, history, language, or current events. Fabricated biblical scholarship, made-up Greek/Hebrew translations, invented etymology. Vaccine conspiracies, COVID denialism, climate denial. NOTE: Do NOT flag skeptical statements that QUESTION or DEBUNK false claims - only flag content that PROMOTES misinformation.',
  },
  {
    name: 'violence',
    description: 'Calls for violence, glorification of violence, citing biblical violence (temple cleansing, holy wars, etc.) as justification for modern aggression, revolutionary rhetoric, threats, Second Amendment intimidation, civil war talk.',
  },
  {
    name: 'christian-nationalism',
    description: 'Using Jesus or Christianity to justify political involvement/aggression, claims Christians should be political "like Jesus was", theocracy advocacy, anti-separation of church/state, demanding "biblical law"',
  },
  {
    name: 'prosperity-gospel',
    description: 'Religious leaders demanding money from followers, "seed faith" offerings, wealth justifications, private jets/luxury defense, "sow to receive" theology',
  },
  {
    name: 'extremism',
    description: 'Defense of oppression/genocide/slavery, white supremacy/nationalism, ethnic cleansing justifications, authoritarian/fascist advocacy, calls for execution/persecution of groups',
  },
  {
    name: 'political-violence',
    description: 'References to political violence events (Capitol riot, insurrections, political attacks), defending/downplaying political violence, false flag claims about violence',
  },
];

// =============================================================================
// VIDEO SUMMARY PROMPT
// =============================================================================
// Used to generate a 2-3 sentence overview of the video content
// This is called AFTER analysis is complete, using the analyzed sections

export const DEFAULT_DESCRIPTION_PROMPT = `Describe what is said in 2-3 sentences.{titleContext}

Sections:
{sectionsSummary}

Description:`;

export const VIDEO_SUMMARY_PROMPT = DEFAULT_DESCRIPTION_PROMPT;

// =============================================================================
// TAG EXTRACTION PROMPT
// =============================================================================
// Used to extract people names and topics from the video

export const DEFAULT_TAG_PROMPT = `Extract people and topics from this transcript.

Return JSON: {"people": ["Name"], "topics": ["Topic"]}

Rules:
- People: proper names only
- Topics: 3-8 themes, 1-3 words each
- Title case

Context: {sectionsContext}

Transcript: {excerpt}

JSON:`;

export const TAG_EXTRACTION_PROMPT = DEFAULT_TAG_PROMPT;

// =============================================================================
// SUGGESTED TITLE PROMPT
// =============================================================================
// Used to generate a suggested filename based on analysis results

export const DEFAULT_TITLE_PROMPT = `Generate a concise, descriptive filename for this video.

Current filename: {currentTitle}
Summary: {description}
People mentioned: {peopleTags}
Topics: {topicTags}

Transcript excerpt:
{transcriptExcerpt}

Rules:
- Lowercase, spaces allowed, max 80 chars
- Format: "[speaker name] - [key quote or action]" or "[speaker] on [topic] - [notable statement]"
- Lead with the main speaker's name if identifiable FROM THE TRANSCRIPT
- If speaker cannot be identified, use descriptive title without a name (e.g., "pastor claims voting democrat is sinful")
- NEVER use names from these examples as defaults - only use names actually found in the transcript
- Include the most notable/quotable phrase in the title
- Add source/show name at end in parentheses if known (e.g., "howard stern", "fox news")
- Be specific about what was SAID, not just the topic
- No dates, extensions, special chars
- Don't invent content not in transcript

Good examples (DO NOT copy these names - identify speakers from the actual transcript):
- "trump on howard stern - i walk into changing rooms because im the owner"
- "pastor claims democrats are demonic and voting for them is sinful"
- "lauren witzke - god must destroy civilization over trans healthcare"
- "fox news host defends border policy with dehumanizing rhetoric"

Output ONLY the filename, nothing else:`;

export const SUGGESTED_TITLE_PROMPT = DEFAULT_TITLE_PROMPT;

// =============================================================================
// QUOTE EXTRACTION PROMPT
// =============================================================================
// Used to extract specific quotes from flagged sections

export const DEFAULT_QUOTE_PROMPT = `Extract 2-4 notable quotes from this transcript.

Category: {category}
Description: {description}

Return JSON: {"quotes": [{"timestamp": "MM:SS", "text": "exact words", "significance": "why notable"}]}

Transcript:
{timestampedText}

JSON:`;

export const QUOTE_EXTRACTION_PROMPT = DEFAULT_QUOTE_PROMPT;


// =============================================================================
// TWO-PASS CHAPTER ANALYSIS PROMPTS
// =============================================================================

// -----------------------------------------------------------------------------
// PASS 1: Boundary Detection Prompt
// -----------------------------------------------------------------------------
// Lightweight prompt for detecting topic changes in a transcript chunk.
// Used to find chapter boundaries without full analysis.

export function buildBoundaryDetectionPrompt(
  videoTitle: string,
  chunkText: string,
  previousTopic: string,
  isFirstChunk: boolean,
  videoDurationSeconds?: number,
): string {
  const titleContext = videoTitle ? `Video: ${videoTitle}\n` : '';
  const prevContext = previousTopic
    ? `Prior section ended on: "${previousTopic}"\n`
    : '';

  // Format duration for display
  let durationContext = '';
  let shortVideoGuidance = '';
  if (videoDurationSeconds !== undefined) {
    const minutes = Math.floor(videoDurationSeconds / 60);
    const seconds = Math.floor(videoDurationSeconds % 60);
    const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    durationContext = `Duration: ${durationStr}\n`;

    // Add guidance for short videos (under 3 minutes)
    if (videoDurationSeconds < 180) {
      shortVideoGuidance =
        '- Short clip: it likely covers ONE subject. Mark a boundary only for a genuinely different subject.\n';
    }
  }

  const firstChunkLine = isFirstChunk
    ? '- Do not mark the very first words — chapter 1 already starts at 0:00.\n'
    : '';

  return `Find where the SUBJECT changes in this transcript. Output JSON only.
${titleContext}${durationContext}${prevContext}
A boundary is where the speaker turns to a clearly different subject — not a new example, tangent, or angle on the same subject.
- Copy the exact 3-8 word phrase from the transcript where the new subject begins.
${shortVideoGuidance}${firstChunkLine}- Also note, in a few words, what the transcript is discussing at its end.

Output exactly this shape and nothing else:
{"boundaries": ["exact phrase where the next subject begins"], "end_topic": "what it is discussing at the end"}

If the subject never changes, output: {"boundaries": [], "end_topic": "..."}

Transcript:
${chunkText}`;
}

// -----------------------------------------------------------------------------
// PASS 2: Chapter Analysis Prompt
// -----------------------------------------------------------------------------
// Full analysis prompt for a single chapter. Generates title, summary, and
// optionally detects category flags within the chapter's content.

/**
 * Map the user's 1-10 sensitivity slider onto a single, mechanical flagging
 * threshold line.
 *
 * This ONLY moves the confidence bar for what counts as a match — it never
 * relaxes the PROMOTING-vs-DEBUNKING guard, and even at the top of the range it
 * still requires the speaker to actually assert the thing (no dog-whistle /
 * subtext / "reminds me of a category" flagging, which destroys precision on a
 * 14B-class model and self-flags counter-apologetics content). The old 1-10
 * escalation that told the model to "flag ANYTHING tenuous" and "create
 * categories freely" was removed for exactly that reason.
 *
 * @param granularity - 1 (strict) to 10 (broad); default handled by the caller.
 */
function getSensitivityLine(granularity: number): string {
  if (granularity <= 3) {
    return 'Sensitivity: strict. Flag only clear, explicit matches you are confident about. When unsure, do not flag.';
  } else if (granularity <= 7) {
    return 'Sensitivity: balanced. Flag clear matches and reasonably likely ones; skip vague or tangential cases.';
  }
  return 'Sensitivity: broad. Flag clear and borderline matches, but the speaker must still be asserting the thing itself — never flag a mere mention, a criticism, or an implication.';
}

export function buildChapterAnalysisPrompt(
  videoTitle: string,
  chapterText: string,
  categories: AnalysisCategory[],
  chapterNumber: number,
  previousChapterSummary?: string,
  customInstructions?: string,
  analysisGranularity?: number,
): string {
  // Only include category instructions if categories exist and are enabled
  const enabledCategories = categories?.filter((c) => c.enabled !== false) || [];
  const hasCategories = enabledCategories.length > 0;

  const categoryList = enabledCategories
    .map((c) => `- ${c.name}: ${c.description}`)
    .join('\n');

  const firstCategory = hasCategories ? enabledCategories[0].name : 'hate';

  const prevContext = previousChapterSummary
    ? `Previous chapter: "${previousChapterSummary}"\n`
    : '';

  const customContext = customInstructions
    ? `Viewer context: ${customInstructions}\n`
    : '';

  // Map the 1-10 slider (default 5 = balanced) onto a single threshold line.
  const granularity = analysisGranularity ?? 5;
  const sensitivityLine = getSensitivityLine(granularity);

  // The flags field in the output-shape example (only when categories exist).
  const flagsField = hasCategories
    ? `,\n  "flags": [{"category": "${firstCategory}", "description": "why the quote matches", "quote": "exact words from the transcript"}]`
    : '';

  // The bullet in the "Produce" list.
  const flagsListItem = hasCategories
    ? '\n- flags: quotes matching a category below; use [] when none match.'
    : '';

  // The full flagging rulebook — the debunking-vs-promoting guard is the #1
  // correctness axis for this counter-apologetics use case, so it leads.
  const flagsBlock = hasCategories
    ? `

THE TEST FOR EVERY FLAG — is the speaker SAYING THIS IS TRUE, or SAYING IT IS FALSE?
Flag ONLY when the speaker asserts, promotes, defends, or urges the claim.
Never flag a speaker who debunks, fact-checks, doubts, mocks, or reports a claim — even when they repeat the claim's words in order to knock it down. Skepticism ("that's a hoax", "there's no evidence", "the courts threw it out") is never a flag.
Judge the whole chapter's stance, not one sentence: if the speaker's point is that the claim is FALSE, flag nothing from it, including the sentence where they state the claim they are about to refute.

Worked examples:
- "The election was stolen, they cheated and everyone knows it." -> FLAG {conspiracy} (asserts it as true)
- "People keep claiming the election was stolen, but every court threw it out for lack of evidence." -> NO FLAG (refutes it)

CATEGORIES:
${categoryList}

Flagging rules:
- quote = exact words copied from the TRANSCRIPT. Never paraphrase, translate, or invent one.
- One quote, one flag, one category. Choose the single best fit; never merge two names (not "hate-conspiracy"). If nothing fits but it clearly qualifies, coin a new lowercase-dashed name.
- description = one sentence on why it matches, and it must describe the speaker ENDORSING the claim.

${sensitivityLine}`
    : '';

  return `Label chapter ${chapterNumber} of a video transcript. Output JSON only.
Video: ${videoTitle}
${prevContext}${customContext}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what the speaker actually says.${flagsListItem}

Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."${flagsField}
}${flagsBlock}

TRANSCRIPT:
${chapterText}`;
}

// -----------------------------------------------------------------------------
// Metadata from Chapters Prompts
// -----------------------------------------------------------------------------

export const DESCRIPTION_FROM_CHAPTERS_PROMPT = `Write a 2-3 sentence description of this video from its chapters. Say specifically what it covers — the people, claims, and topics the chapters name, not generic filler. Output only the description, no preamble.

Video: {videoTitle}
Chapters:
{chaptersList}

Description:`;

export const TAGS_FROM_CHAPTERS_PROMPT = `List the people and topics in these video chapters. Output JSON only.
- people: proper names of people mentioned in the chapters, Title Case.
- topics: 3-8 subjects, 1-3 words each, Title Case.

Output exactly this shape and nothing else:
{"people": ["Jane Doe"], "topics": ["Election Fraud", "Immigration"]}

Chapters:
{chaptersList}`;

export const TITLE_FROM_CHAPTERS_PROMPT = `Write a filename describing this video, from its chapters. Output only the filename.

Chapters:
{chaptersList}
Current filename (reference only): {currentTitle}

Rules:
- lowercase; separate words with spaces (not hyphens or underscores); max 80 chars; no dates, file extension, parentheses, or special characters
- if the chapters name the main speaker, lead with them: "speaker name - the striking thing they said"
- if no speaker is identifiable, describe what was said: "pastor claims voting democrat is sinful"
- capture the single most notable or quotable point, using a short verbatim phrase when one stands out
- use only names and facts that appear in these chapters

The two lines below show the SHAPE only — do not reuse their names or wording, take everything from the chapters above:
- "<speaker> - <their most striking quote>"
- "<role> claims <specific claim>"

Filename:`;

export const TITLE_FROM_WEBPAGE_PROMPT = `Write a filename for this saved webpage from its content. Output only the filename.

Current filename (reference only): {currentTitle}
Page content:
{pageText}

Rules:
- lowercase; separate words with spaces (not hyphens or underscores); max 80 chars; no dates, file extension, parentheses, or special characters
- if a person or source is clearly the subject, lead with them; otherwise use a specific topical title, e.g. "senate passes surveillance bill extending section 702"
- lead with the single most notable point; use only what appears in the content

The two lines below show the SHAPE only — do not reuse their names or wording:
- "<source> - <specific development>"
- "<person> on <topic>"

Filename:`;

// =============================================================================
// DEFAULT PROMPTS EXPORT
// =============================================================================
// All default prompts in one object for easy access by config system

export const DEFAULT_PROMPTS = {
  description: DEFAULT_DESCRIPTION_PROMPT,
  title: DEFAULT_TITLE_PROMPT,
  tags: DEFAULT_TAG_PROMPT,
  quotes: DEFAULT_QUOTE_PROMPT,
};

// =============================================================================
// PROMPT INTERPOLATION HELPER
// =============================================================================
// Replaces {placeholder} tokens in prompt templates with actual values

export function interpolatePrompt(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}
