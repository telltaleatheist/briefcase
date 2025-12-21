/**
 * AI Analysis Prompts and Categories for ClipChimp Video Analysis
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
- Lead with the main speaker's name if identifiable
- Include the most notable/quotable phrase in the title
- Add source/show name at end in parentheses if known (e.g., "howard stern", "fox news")
- Be specific about what was SAID, not just the topic
- No dates, extensions, special chars
- Don't invent content not in transcript

Good examples:
- "mario murillo - voting democrat is devilish and spitting on apostles graves"
- "trump on howard stern - i walk into changing rooms because im the owner"
- "lauren witzke - god must destroy civilization over trans healthcare"
- "nick fuentes on mtg at afpac - from praise to criticism"

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
): string {
  const titleContext = videoTitle ? `Video: ${videoTitle}\n` : '';
  const prevContext = previousTopic
    ? `Previous section was about: "${previousTopic}"\n`
    : '';

  return `Mark where the topic/subject changes in this transcript.
${titleContext}${prevContext}
Rules:
- Only mark SIGNIFICANT topic changes, not minor tangents
- Return the exact phrase (3-8 words) where each new topic begins
${isFirstChunk ? '- Do NOT include the very first words (chapter 1 starts automatically at 0:00)\n' : ''}- Also summarize what topic this section ends with (for context to next chunk)

Return JSON:
{
  "boundaries": ["exact phrase where topic 2 starts", "exact phrase where topic 3 starts"],
  "end_topic": "Brief description of what the section ends discussing"
}

If no topic changes occur, return: {"boundaries": [], "end_topic": "..."}

Transcript:
${chunkText}`;
}

// -----------------------------------------------------------------------------
// PASS 2: Chapter Analysis Prompt
// -----------------------------------------------------------------------------
// Full analysis prompt for a single chapter. Generates title, summary, and
// optionally detects category flags within the chapter's content.

/**
 * Get granularity-based flagging instructions
 * @param granularity - 1 (very strict) to 10 (extremely aggressive)
 */
function getGranularityInstructions(granularity: number): { approach: string; rule: string } {
  if (granularity <= 2) {
    return {
      approach: 'BE VERY STRICT - only flag content that CLEARLY and DEFINITIVELY matches categories. Require strong, unambiguous evidence.',
      rule: 'ONLY flag if you are highly confident the content matches. When in doubt, do NOT flag. Prefer false negatives over false positives.',
    };
  } else if (granularity <= 4) {
    return {
      approach: 'BE STRICT - flag content with HIGH confidence matches only. Require clear evidence.',
      rule: 'Flag when you have strong confidence the content matches a category. Skip borderline or ambiguous cases.',
    };
  } else if (granularity <= 6) {
    return {
      approach: 'BE BALANCED - flag content with reasonable confidence. Include clear matches and likely matches.',
      rule: 'Flag content that reasonably matches categories. Include likely matches but skip very weak associations.',
    };
  } else if (granularity <= 8) {
    return {
      approach: 'BE BROAD - flag content liberally. Include edge cases and possible matches.',
      rule: 'FLAG GENEROUSLY - if content MIGHT qualify for a category, flag it. Include edge cases and possible matches.',
    };
  } else if (granularity === 9) {
    return {
      approach: 'BE VERY AGGRESSIVE - flag ALL possible matches including weak associations. Better to over-flag than miss anything.',
      rule: 'FLAG EVERYTHING that could possibly relate to any category. Missing a potential flag is unacceptable. Include even weak or tangential associations.',
    };
  } else {
    // Level 10: MAXIMUM AGGRESSION
    return {
      approach: 'MAXIMUM DETECTION MODE - Flag ANYTHING that could CONCEIVABLY, REMOTELY, or TANGENTIALLY relate to ANY category. Cast the widest possible net. When in doubt, FLAG IT. You are being paid to find matches - find them all, no matter how tenuous.',
      rule: 'FLAG AGGRESSIVELY AND LIBERALLY. If a word, phrase, tone, implication, or subtext could POSSIBLY be interpreted as relating to a category - even through multiple degrees of separation - FLAG IT. This includes: indirect references, metaphors, analogies, dog whistles, coded language, implications, things that REMIND you of a category, adjacent topics, things that could lead to category topics, and anything that makes you even slightly think of a category. Your job is to surface EVERY POSSIBLE match. False positives are acceptable and expected. Missing a potential match is a FAILURE. When uncertain, ALWAYS flag. Create new categories freely if existing ones don\'t fit. Err on the side of maximum coverage. The user wants to catch EVERYTHING.',
    };
  }
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
    .map((c) => `- **${c.name}**: ${c.description}`)
    .join('\n');

  const categoryNames = enabledCategories.map((c) => c.name).join(', ');

  const prevContext = previousChapterSummary
    ? `\nPrevious chapter covered: "${previousChapterSummary}"\n`
    : '';

  const customContext = customInstructions
    ? `\nUSER CONTEXT:\n${customInstructions}\n`
    : '';

  // Get granularity-based instructions (default to 5 - balanced)
  const granularity = analysisGranularity ?? 5;
  const granularityInstr = getGranularityInstructions(granularity);

  // Category section
  const categorySection = hasCategories
    ? `
3. Flag specific problematic quotes. Categories:
${categoryList}`
    : '';

  const flagsInstruction = hasCategories
    ? `,
  "flags": [
    {"category": "${categoryNames.split(', ')[0]}", "description": "one sentence why", "quote": "EXACT words copied from transcript"}
  ]`
    : '';

  const flagsNote = hasCategories
    ? `

DETECTION SENSITIVITY: ${granularity}/10 - ${granularityInstr.approach}

FLAGS RULES:
1. ${granularityInstr.rule}
2. "quote" = copy/paste exact words from TRANSCRIPT above. Do NOT paraphrase or summarize.
3. Each unique quote gets exactly ONE flag with ONE category. Never flag the same quote twice.
4. category should be one of: ${categoryNames}
   - OR create a new category if content doesn't fit (use lowercase-with-dashes, e.g., "cult-tactics")
   - Do NOT combine categories (wrong: "hate-conspiracy", right: pick one or create new)
5. "flags": [] ONLY if absolutely nothing matches any category

CRITICAL - DEBUNKING vs PROMOTING:
- Do NOT flag someone DEBUNKING or expressing SKEPTICISM about conspiracy theories, pseudoscience, or misinformation
- Saying "this is fake", "this is a hoax", or "I don't know how they came to that conclusion" about unverified/extraordinary claims is HEALTHY SKEPTICISM, not misinformation
- Only flag content that PROMOTES false claims, not content that QUESTIONS them
- If the speaker is clearly analyzing, critiquing, or debunking dubious claims, their skeptical statements should NOT be flagged

EXAMPLE FLAG:
{"category": "hate", "description": "dehumanizing language toward immigrants", "quote": "these people are like animals invading our country"}

WRONG: Two flags for same content with different categories
WRONG: Combined categories like "misinformation-conspiracy"
WRONG: Paraphrasing the quote instead of copying exact words
RIGHT: One flag per quote, one category (existing or new), exact transcript words`
    : '';

  const flagsListItem = hasCategories ? '\n- flags: array of problematic quotes' : '';

  return `Analyze this transcript chapter.${hasCategories ? ' ' + granularityInstr.approach : ''}
Video: ${videoTitle}
Chapter: ${chapterNumber}
${prevContext}${customContext}
Return JSON with:
- title: 1-3 sentence description
- summary: 2-3 sentence summary${flagsListItem}${categorySection}

JSON format:
{
  "title": "...",
  "summary": "..."${flagsInstruction}
}${flagsNote}

TRANSCRIPT:
${chapterText}`;
}

// -----------------------------------------------------------------------------
// Metadata from Chapters Prompts
// -----------------------------------------------------------------------------

export const DESCRIPTION_FROM_CHAPTERS_PROMPT = `Generate a 2-3 sentence description of this video based on its chapters.

Video title: {videoTitle}

Chapters:
{chaptersList}

Rules:
- Describe what the video covers based on the chapter summaries
- Be specific about the content, not generic
- 2-3 sentences maximum

Description:`;

export const TAGS_FROM_CHAPTERS_PROMPT = `Extract people and topics from these video chapters.

Return JSON: {"people": ["Name"], "topics": ["Topic"]}

Rules:
- People: proper names only (from chapter content)
- Topics: 3-8 themes, 1-3 words each
- Title case

Chapters:
{chaptersList}

JSON:`;

export const TITLE_FROM_CHAPTERS_PROMPT = `Generate a concise, descriptive filename for this video based on its chapters.

Current filename: {currentTitle}
Chapters:
{chaptersList}

Rules:
- Lowercase, spaces allowed, max 80 chars
- Format: "[speaker name] - [key quote or action]" or "[speaker] on [topic] - [notable statement]"
- Lead with the main speaker's name if identifiable
- Include the most notable/quotable phrase in the title
- Add source/show name at end in parentheses if known
- Be specific about what was SAID, not just the topic
- No dates, extensions, special chars

Good examples:
- "mario murillo - voting democrat is devilish and spitting on apostles graves"
- "trump on howard stern - i walk into changing rooms because im the owner"
- "lauren witzke - god must destroy civilization over trans healthcare"

Output ONLY the filename, nothing else:`;

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
