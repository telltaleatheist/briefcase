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
    description: 'Political conspiracy theories (election fraud, deep state, QAnon, globalists, voter fraud, "stolen election", New World Order, Illuminati, Freemasons, Soros conspiracies, etc.)',
  },
  {
    name: 'false-prophecy',
    description: 'ANY claims of divine communication or prophecy (God speaking to them, prophetic declarations, divine revelations, "God told me", supernatural knowledge claims, prophecies about political/world events)',
  },
  {
    name: 'misinformation',
    description: 'Factually incorrect claims about science, medicine, history, language, or current events. Fabricated biblical scholarship, made-up Greek/Hebrew translations (e.g., claiming words mean something they don\'t), invented etymology used to attack groups. Vaccine conspiracies, COVID denialism, climate denial.',
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

export const DEFAULT_TITLE_PROMPT = `Generate a descriptive filename for this video.

Current filename: {currentTitle}
Summary: {description}
People mentioned: {peopleTags}
Topics: {topicTags}

Transcript excerpt:
{transcriptExcerpt}

Rules:
- Lowercase, spaces, max 100 chars
- Natural phrase describing what the video is about
- Keep channel/show names from original title if present
- Describe the ACTUAL content from transcript, not just topics
- No dates, extensions, special chars
- Don't invent content not in transcript

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
// SECTION IDENTIFICATION PROMPT BUILDER
// =============================================================================
// Builds the section identification prompt dynamically based on user's categories

export function buildSectionIdentificationPrompt(
  titleContext: string,
  customSection: string,
  chunkNum: number,
  chunkText: string,
  categories: AnalysisCategory[] | null,
): string {
  // NO fallbacks - if categories are missing, we should fail
  if (!categories || categories.length === 0) {
    throw new Error(
      'No analysis categories provided. Categories must be configured in Settings before running analysis.',
    );
  }

  // Filter to enabled categories only
  const enabledCategories = categories.filter((c) => c.enabled !== false);

  // Fail if no enabled categories
  if (enabledCategories.length === 0) {
    throw new Error(
      'No enabled analysis categories found. At least one category must be enabled in Settings.',
    );
  }

  // Build category list for JSON format
  const categoryNames = enabledCategories.map((c) => c.name).join(', ');

  // Build category descriptions
  const categoryDescriptions = enabledCategories.map(
    (cat) => `- **${cat.name}** - ${cat.description || ''}`,
  );

  const categoriesSection =
    categoryDescriptions.length > 0 ? categoryDescriptions.join('\n') : '';

  // Build the prompt (only flag problematic content, no routine sections)
  const prompt = `You are analyzing video transcripts for a research archive documenting extremist content. Your job is to identify and categorize ALL problematic content - do not stop at the first issue found.

Flag problematic content in this transcript. ONLY return sections that match the defined categories - skip normal/routine content.
${titleContext}${customSection}
Categories:
${categoriesSection}

Return JSON:
{"sections": [{"start_phrase": "exact quote", "end_phrase": "exact quote", "category": "${categoryNames}", "description": "one sentence", "quote": "exact words"}]}

Rules:
- start_phrase and end_phrase MUST be verbatim text copied from the transcript (3-8 words) - these are used for timestamp lookup
- Read each category definition carefully
- If the transcript discusses, targets, or mentions anything in a category definition, use that category
- CRITICAL: Each section must have EXACTLY ONE category - never combine categories with commas
- If content matches multiple categories (e.g., both "violence" AND "christian-nationalism"), create SEPARATE sections for each - one section for "violence", another section for "christian-nationalism", even if they have the same start/end phrases
- Category must be exactly ONE of: ${categoryNames} (no comma-separated lists)
- If NO content matches any category, return {"sections": []} - do NOT create sections for normal content
- Short videos: one section per category. Long videos: 30s-2min sections per category

Transcript #${chunkNum}:
${chunkText}`;

  return prompt;
}

// =============================================================================
// CHAPTER DETECTION PROMPT BUILDER
// =============================================================================
// Builds the chapter detection prompt for identifying topic changes in video

export function buildChapterDetectionPrompt(
  titleContext: string,
  chunkText: string,
): string {
  const prompt = `Identify chapter boundaries based on topic/subject changes in this transcript.
${titleContext}
Rules:
- First chapter MUST start at the very beginning of the transcript
- Create a new chapter ONLY when the subject/topic significantly changes
- Very short videos (under 2 minutes) may have just 1 chapter - that's fine
- Longer videos should have 2-8 chapters depending on content
- Minimum chapter length: ~30 seconds of content

Title requirements:
- Titles should be DETAILED DESCRIPTIONS - a sentence, two sentences, or even a short paragraph
- Explain SPECIFICALLY what is being discussed, shown, or said in this section
- Avoid generic section labels like "Introduction", "Opening", "Conclusion", "Overview"
- Avoid vague references - be specific enough that someone reading just the title understands the content
- Include key details: names, topics, actions, subjects being discussed

Return JSON:
{"chapters": [{"start_phrase": "exact quote from transcript", "title": "Detailed description of this section's content"}]}

Important:
- start_phrase MUST be verbatim text copied from the transcript (3-8 words) - these are used for timestamp lookup
- The first chapter's start_phrase should be from the very beginning of the transcript
- Each subsequent chapter's start_phrase marks where a new topic begins
- Chapters are sequential - each one ends where the next begins
- The last chapter extends to the end of the video

Transcript:
${chunkText}`;

  return prompt;
}

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
