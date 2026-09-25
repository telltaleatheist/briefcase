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
// PASS 2: Chapter Analysis Prompt
// -----------------------------------------------------------------------------
// Full analysis prompt for a single chapter. Generates title, summary, and
// optionally detects category flags within the chapter's content.

/**
 * Chapter titling and summarization ONLY.
 *
 * Category flagging deliberately does NOT live here. It used to be a third
 * field on this prompt's JSON, which meant the model split its budget three
 * ways and treated `flags` as an afterthought — it reliably returned two or
 * three obvious quotes per chapter and stopped. Flagging now gets its own
 * dedicated call (buildFlagExtractionPrompt) whose only job is extraction.
 */
export function buildChapterAnalysisPrompt(
  videoTitle: string,
  chapterText: string,
  chapterNumber: number,
  previousChapterSummary?: string,
  customInstructions?: string,
): string {
  const prevContext = previousChapterSummary
    ? `Previous chapter: "${previousChapterSummary}"\n`
    : '';

  const customContext = customInstructions
    ? `Viewer context: ${customInstructions}\n`
    : '';

  return `Label chapter ${chapterNumber} of a video transcript. Output JSON only.
Video: ${videoTitle}
${prevContext}${customContext}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what the speaker actually says.

Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."
}

TRANSCRIPT:
${chapterText}`;
}

/**
 * PROMPT IDENTITY for the flag verifier — the version stamp that invalidates the
 * stored-verdict cache.
 *
 * Verdicts are cached in the library database keyed by, among other things, a
 * hash of THIS string (see FlagVerdictCache in database.service.ts). The cache
 * is keyed on the QUESTION, and the prompt template is half the question: the
 * same passage and the same claim put to a differently-worded grader is a
 * different question and must not reuse the old answer.
 *
 * BUMP THIS whenever `buildFlagVerificationPrompt` below changes a single
 * character of what the model reads — wording, ordering, the JSON instruction,
 * anything. Forgetting to bump it is the one failure mode of the cache that is
 * silent: every stale verdict is served as if it had been asked of the new
 * prompt.
 *
 * Do NOT bump it for changes that do not reach the model (comments, types,
 * logging), or every user pays a full re-verify for nothing.
 *
 * v3 (2026-08-25) — the sensitivity ladder was removed from this prompt; every
 * candidate is now asked the calibrated question that sensitivity 2 asked. See
 * the retirement note below.
 *
 * v4 (2026-09-24) — the answer carries a written justification beside the
 * verdict (`reason`), which becomes the flag section's description (the user:
 * "give a written justification for the markers"). The question is unchanged.
 */
export const FLAG_VERIFICATION_PROMPT_VERSION = 'flag-verify/v4-justified-2026-09-24';

/**
 * THE VERIFICATION EMPHASIS LADDER IS RETIRED (operator ruling, 2026-08-25).
 *
 * WHAT IT WAS. `VERIFICATION_EMPHASIS` was a Record<1|2|3|4|5, string> appended
 * to the verifier's prompt: nothing at sensitivity 2 (the calibrated
 * configuration), a "reserve flag for outright statements" clause at 1, and
 * progressively harder leans toward "flag" at 3, 4 and 5. It was the dial's
 * second half — the ranker's threshold decided WHAT WAS ASKED, and this decided
 * how the answer leaned.
 *
 * WHY IT IS GONE. The pipeline now captures at its widest ONCE and stores EVERY verdict,
 * flag and skip, with the window's score. The dial became a display filter over
 * stored verdicts, applied client-side with no re-run. In that world a leaning
 * clause is not a dial, it is a bias: it would bake ONE run's lean into the
 * stored record that every later filter position reads. A verdict that says
 * "flag, because that run was told to lean toward flag" cannot be un-leaned by
 * a STRICT filter afterwards, and a verdict that says "skip, because that run
 * was told to reserve flag for outright statements" is a finding LOOSE can
 * never recover.
 *
 * So there is exactly one grader now, and it is the measured one: the empty
 * emphasis that sensitivity 2 used, which scored 10/10 on the hand audit of the
 * 12-minute reference video with 0 extras. Every candidate, at every capture
 * depth, is asked that same question. What the user's dial moves is which of the
 * stored answers are shown.
 *
 * THE REPORT-VS-ASSERT GUARD IS UNAFFECTED and stays exactly where it was, in
 * the prompt body below. It is the #1 correctness axis for this
 * counter-apologetics use case — the operator's own commentary must never flag
 * itself for quoting the thing it criticizes. MEASURED, and still the crux case:
 * the passage at 03:12 of the political reference video ("The president and
 * Republicans have been very eager to paint the entire Democratic party as
 * communists and Marxists") verifies as "skip" on both categories it fires. It
 * is now STORED as that skip rather than discarded, and shows up ghosted at the
 * LOOSE filter position with the verifier's reason attached.
 *
 * (The open-ended discovery fallback that kept a run-input dial was removed
 * with the NLI ranker in P7: every flag goes through this verifier now.)
 */

/**
 * Verify ONE (window, category) pair: does this PASSAGE contain the speaker
 * asserting the category's proposition, or only reporting/questioning/arguing
 * against it?
 *
 * This is the second half of the flag pipeline (after the snap ranker). A
 * ranker cannot tell stance apart — "these candidates are communists" and
 * "Republicans have been eager to paint them as communists" read alike to it —
 * so every category a window fired gets exactly one question asked about it here.
 *
 * WHY A PASSAGE AND NOT A MARKED SENTENCE. The unit of scoring is the sentence;
 * the unit of JUDGMENT is the passage the ranker's hot sentences were expanded
 * into. Asking about a marked sentence produced one stored section per sentence,
 * and a speaker who spends four sentences on one point came back as four
 * back-to-back flags for a single moment. One question per passage means one
 * verdict per passage, which is what makes one section per moment possible —
 * and the neighbouring sentences that used to be labelled "context" are now
 * part of what is being judged, which is also what a human reviewer would do.
 *
 * WHAT THIS PROMPT DELIBERATELY DOES NOT CONTAIN, per the hygiene ruling in
 * docs/youtube-metadata-spec.md §6.1: no incorrect examples, no ban lists.
 * Both verdicts are DEFINED positively — what earns "flag", what earns "skip" —
 * rather than illustrated with a wrong answer the model might copy.
 *
 * It keeps the spirit of the old flag-extraction prompt's promoting-vs-debunking
 * guard, which is the #1 correctness axis for this counter-apologetics use case
 * (the operator's own commentary must never flag itself for quoting the thing
 * it criticizes) — scoped to one passage and one claim instead of a whole
 * chapter's stance and an open-ended list of findings.
 */
export function buildFlagVerificationPrompt(
  passage: string[],
  categoryName: string,
  stanceProposition: string,
): string {
  return `Transcript passage.

${passage.join('\n')}

CLAIM (${categoryName}): ${stanceProposition}

Question: anywhere in this passage, is the speaker asserting or promoting that claim as their own position?
Answer "flag" if the speaker asserts it, endorses it, or repeats it approvingly as true.
Answer "skip" if the speaker is reporting that other people make that claim, quoting it neutrally, asking about it, arguing against it, or if the passage does not make that claim at all.

Then give the reason in one or two sentences: what the speaker says in this passage, and why that is or is not asserting the claim. Name the speaker's own words where they settle it.

Respond with JSON only: {"verdict":"flag" or "skip","reason":"..."}`;
}

// -----------------------------------------------------------------------------
// Metadata from Chapters Prompts
// -----------------------------------------------------------------------------

/**
 * PROMPT-HYGIENE RULING (docs/youtube-metadata-spec.md §6.1, operator,
 * 2026-08-22) — binding on everything in this section:
 *
 *   Prompts carry CORRECT examples only. No incorrect examples, no ban lists,
 *   ever. A model shown the bad form sometimes reproduces it, so the wrong forms
 *   live exclusively in code (the narrated-actor detector in
 *   description-composer.ts) and in the spec's own prose — never in anything a
 *   model reads. Re-asks follow the same rule: restate the positive instruction,
 *   never echo the rejected output or describe what was wrong with it.
 *
 * The register instruction below is therefore phrased as grammar to USE, not
 * grammar to avoid.
 */

/**
 * The hook line: the first ~150 characters of the description, which is the
 * search-results snippet and everything a mobile viewer sees above the fold.
 * Schema-constrained ({"hook": string}) on Ollama — see spec §5.
 */
export const HOOK_FROM_CHAPTERS_PROMPT = `Write the opening line of the YouTube description for this video. Output JSON only.

One sentence, 150 characters maximum. Open with the exact phrase a viewer would type into search, at the very front of the line. Make it a precise promise of what the video actually shows. Include the specific people, places, claims and events when they are the draw.

Write about the topics and the named people directly, in topic form — bare noun phrases or gerunds as sentence subjects.

Lines in this style:
- "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
- "Kent Christmas's 2021 death-angel prophecy"

Video: {videoTitle}
Chapter titles:
{chapterTitles}
Topics: {topics}

Output exactly this shape and nothing else:
{"hook": "your one sentence here"}`;

/**
 * The body paragraph: 150-300 words woven from ALL chapter summaries. The
 * summaries narrate internally ("the speaker argues…") and that is correct for
 * internal data — the register instruction here is what keeps that register from
 * reaching the published field. Schema-constrained ({"body": string}) on Ollama.
 */
export const BODY_FROM_CHAPTERS_PROMPT = `Write the body paragraph of the YouTube description for this video. Output JSON only.

One paragraph, between 150 and 300 words. Weave the chapters into a single continuous paragraph covering what happens and who says what. Name the real people, places, claims and events — every specific name is a search a viewer might run.

Write in topic form throughout — bare noun phrases or gerunds as sentence subjects. Keep every real name, as possessives and objects: "Trump's refusal", "Paul Petit's report on the ceasefire", "Gene Bailey's misreading of Luke 19:13". The whole paragraph reads like the example lines below, only longer.

Phrasing in this style:
- "Debate about Trump's refusal to extend the Iran ceasefire MOU and rising tensions in the Strait of Hormuz"
- "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
- "Kent Christmas's 2021 death-angel prophecy and the fallout among charismatic prophets"

Video: {videoTitle}
People in this video: {people}
Chapters:
{chapterSummaries}

Output exactly this shape and nothing else:
{"body": "your paragraph here"}`;

/**
 * Appended verbatim for the ONE re-ask the narrated-actor detector is allowed to
 * trigger. It restates the positive instruction and shows correct forms again;
 * it does not quote, echo, paraphrase or characterise the rejected output, per
 * the hygiene ruling above.
 */
export const REGISTER_RESTATEMENT = `
Write in topic form throughout — bare noun phrases or gerunds as sentence subjects. Keep every real name, as possessives and objects.

Phrasing in this style:
- "Kent Christmas's 2021 death-angel prophecy"
- "Debate about Trump's refusal to extend the Iran ceasefire MOU"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"`;

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
