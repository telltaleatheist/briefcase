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
    description: 'Discrimination, dehumanization, or calls for harm against ANY minority group (LGBTQ+, racial minorities, religious minorities, ethnic groups, immigrants, etc.), including "biblical" justifications for hatred',
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
    description: 'Factually incorrect or misleading claims about science, medicine, history, or current events (vaccine conspiracies, COVID denialism, alternative medicine fraud, historical revisionism, climate denial, etc.)',
  },
  {
    name: 'violence',
    description: 'Explicit or implicit calls for violence, revolutionary rhetoric, threats, Second Amendment intimidation, civil war talk, bloodshed predictions, "rise up" rhetoric, militia organizing',
  },
  {
    name: 'christian-nationalism',
    description: 'Claims that church/Christianity should control government, theocracy advocacy, anti-separation of church/state, demanding "biblical law", opposition to secular governance',
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
  {
    name: 'routine',
    description: 'Generic description of what is happening - use ONLY when no other category applies',
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

  // Build category descriptions (excluding 'routine' which is default)
  const categoryDescriptions: string[] = [];
  let routineDesc: string | null = null;

  for (const cat of enabledCategories) {
    if (cat.name === 'routine') {
      routineDesc = cat.description || 'Normal content analysis';
    } else {
      categoryDescriptions.push(
        `- **${cat.name}** - ${cat.description || ''}`,
      );
    }
  }

  const categoriesSection =
    categoryDescriptions.length > 0 ? categoryDescriptions.join('\n') : '';

  // Build the prompt (minimal framing, strong category matching)
  const prompt = `Categorize this transcript.
${titleContext}${customSection}
Categories:
${categoriesSection}

routine: ${routineDesc || 'Use ONLY when no other category applies'}

Return JSON:
{"sections": [{"start_phrase": "exact quote", "end_phrase": "exact quote", "category": "${categoryNames}", "description": "one sentence", "quote": "exact words"}]}

Rules:
- Read each category definition carefully
- If the transcript discusses, targets, or mentions anything in a category definition, use that category
- Only use "routine" when content matches NONE of the other categories
- Category must be ONE of: ${categoryNames}
- Short videos: one section. Long videos: 30s-2min sections

Transcript #${chunkNum}:
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
