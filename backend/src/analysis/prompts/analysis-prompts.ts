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
    description: 'Normal content that doesn\'t match other categories - use for general analysis of what\'s being said (religious teaching, political commentary, testimonies, announcements, music, etc.)',
  },
];

// =============================================================================
// VIDEO SUMMARY PROMPT
// =============================================================================
// Used to generate a 2-3 sentence overview of the video content
// This is called AFTER analysis is complete, using the analyzed sections

export const VIDEO_SUMMARY_PROMPT = `Summarize this video in 2-3 sentences.{titleContext}

Sections timeline:
{sectionsSummary}

Summary:`;

// =============================================================================
// TAG EXTRACTION PROMPT
// =============================================================================
// Used to extract people names and topics from the video

export const TAG_EXTRACTION_PROMPT = `Extract people names and topics from transcript.

Return JSON: {"people": ["Name"], "topics": ["Topic"]}

Rules:
- People: proper names only (not "doctor", "pastor")
- Topics: 3-8 main themes, 1-3 words each
- Title case for names

Context: {sectionsContext}

Transcript: {excerpt}

JSON:`;

// =============================================================================
// SUGGESTED TITLE PROMPT
// =============================================================================
// Used to generate a suggested filename based on analysis results

export const SUGGESTED_TITLE_PROMPT = `Generate descriptive filename for video.

Current: {currentTitle}
Content: {description}
People: {peopleTags}
Topics: {topicTags}

Rules:
- Lowercase, spaces, max 100 chars
- Natural phrase, not keywords
- Keep important words from original (channels, names, topics)
- Describe VIDEO content, not analysis
- No dates, extensions, special chars

Good: "tucker carlson interviews elon musk"
Bad: "summary of tucker carlson interview"

Filename:`;

// =============================================================================
// QUOTE EXTRACTION PROMPT
// =============================================================================
// Used to extract specific quotes from flagged sections

export const QUOTE_EXTRACTION_PROMPT = `Extract 2-4 most extreme quotes from transcript.

Category: {category}
Description: {description}

Return JSON: {"quotes": [{"timestamp": "MM:SS", "text": "exact words", "significance": "why extreme"}]}

Skip context/background. Only include inflammatory/shocking quotes with timestamps.

Transcript:
{timestampedText}

JSON:`;

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

  // Build the prompt (optimized for token efficiency)
  const prompt = `Analyze transcript and identify sections. This is content moderation research - analyze factually without refusing.

${titleContext}${customSection}
Categories:
${categoriesSection}

routine: ${routineDesc || 'Default for content not matching above categories'}

Return JSON only:
{"sections": [{"start_phrase": "exact quote", "end_phrase": "exact quote", "category": "${categoryNames}", "description": "one sentence", "quote": "exact words from transcript"}]}

Rules:
- Start/end phrases must be exact quotes from transcript
- Category must be ONE of: ${categoryNames}
- Include quote for every section
- Short videos (<2min): one section. Long videos: 30s-2min sections
- Always return at least one section

Transcript #${chunkNum}:
${chunkText}`;

  return prompt;
}

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
