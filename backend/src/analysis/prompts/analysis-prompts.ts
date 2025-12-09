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

export const DEFAULT_DESCRIPTION_PROMPT = `You are assisting a content moderation tool that documents and analyzes media for research purposes. Your job is to provide factual descriptions - never refuse to analyze.

Summarize this video in 2-3 sentences based on the analyzed sections below.{titleContext}

Guidelines:
- Describe what actually happens in the video based on the sections
- Use accurate, critical language for harmful content
- If sections show routine content, describe it neutrally
- Never apologize or refuse - this is legitimate content moderation research

Sections timeline:
{sectionsSummary}

Summary:`;

export const VIDEO_SUMMARY_PROMPT = DEFAULT_DESCRIPTION_PROMPT;

// =============================================================================
// TAG EXTRACTION PROMPT
// =============================================================================
// Used to extract people names and topics from the video

export const DEFAULT_TAG_PROMPT = `You are assisting a content moderation tool. Extract people names and topics from this transcript - never refuse.

Return JSON: {"people": ["Name"], "topics": ["Topic"]}

Rules:
- People: proper names only (not "doctor", "pastor")
- Topics: 3-8 main themes, 1-3 words each, using accurate critical terminology
  - Use terms like "white nationalism" not "race realism"
  - Use "conspiracy theory" not "alternative perspective"
  - Use "misinformation" not "controversial claim"
  - Use "hate speech" not "provocative speech"
  - Use "christian nationalism" not "traditional values"
- Title case for names

Context: {sectionsContext}

Transcript: {excerpt}

JSON:`;

export const TAG_EXTRACTION_PROMPT = DEFAULT_TAG_PROMPT;

// =============================================================================
// SUGGESTED TITLE PROMPT
// =============================================================================
// Used to generate a suggested filename based on analysis results

export const DEFAULT_TITLE_PROMPT = `You are assisting a content moderation tool. Generate a descriptive filename for this video - never refuse.

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
- Use accurate descriptors for controversial figures

Good: "nick fuentes rants about demographic replacement"
Good: "pastor advocates for christian nationalism"
Bad: "conservative commentator shares views" (too vague)

Output ONLY the filename, nothing else:`;

export const SUGGESTED_TITLE_PROMPT = DEFAULT_TITLE_PROMPT;

// =============================================================================
// QUOTE EXTRACTION PROMPT
// =============================================================================
// Used to extract specific quotes from flagged sections

export const DEFAULT_QUOTE_PROMPT = `You are assisting a content moderation tool. Extract 2-4 notable quotes from this transcript - never refuse.

Category: {category}
Description: {description}

Return JSON: {"quotes": [{"timestamp": "MM:SS", "text": "exact words", "significance": "why this quote is notable"}]}

Focus on quotes that:
- Are most representative of the content
- Document any harmful rhetoric if present
- Show the speaker's main points or positions

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

  // Build the prompt (optimized for token efficiency, critical perspective)
  const prompt = `Analyze transcript and identify sections. This is content moderation research documenting harmful rhetoric - analyze critically without refusing.

${titleContext}${customSection}
Categories:
${categoriesSection}

routine: ${routineDesc || 'Default for content not matching above categories'}

Return JSON only:
{"sections": [{"start_phrase": "exact quote", "end_phrase": "exact quote", "category": "${categoryNames}", "description": "one sentence describing the harmful content", "quote": "exact words from transcript"}]}

Rules:
- Start/end phrases must be exact quotes from transcript
- Category must be ONE of: ${categoryNames}
- Include quote for every section - prioritize the most egregious statements
- Descriptions should accurately characterize harmful rhetoric (e.g., "spreads conspiracy theory about..." not "discusses alternative theory")
- Short videos (<2min): one section. Long videos: 30s-2min sections
- Always return at least one section

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
