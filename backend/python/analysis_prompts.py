"""
AI Analysis Prompts for ClipChimp Video Analysis

This file contains all prompts used by the AI analysis system.
Edit these prompts to customize how videos are analyzed.

Each prompt is a template string that accepts various parameters.
Use {variable_name} syntax for placeholders that will be filled in at runtime.
"""

# =============================================================================
# VIDEO SUMMARY PROMPT
# =============================================================================
# Used to generate a 2-3 sentence overview of the video content
# This is called AFTER analysis is complete, using the analyzed sections
# Variables:
#   - title_context: optional video title/filename context (str)
#   - sections_summary: summary of all analyzed sections covering the full video (str)
# =============================================================================

VIDEO_SUMMARY_PROMPT = """Summarize this video in 2-3 sentences.{title_context}

Sections timeline:
{sections_summary}

Summary:"""


# =============================================================================
# TAG EXTRACTION PROMPT
# =============================================================================
# Used to extract people names and topics from the video
# Variables:
#   - sections_context: summary of analyzed section descriptions (str)
#   - excerpt: transcript excerpt for tag extraction (str)
# =============================================================================

TAG_EXTRACTION_PROMPT = """Extract people names and topics from transcript.

Return JSON: {{"people": ["Name"], "topics": ["Topic"]}}

Rules:
- People: proper names only (not "doctor", "pastor")
- Topics: 3-8 main themes, 1-3 words each
- Title case for names

Context: {sections_context}

Transcript: {excerpt}

JSON:"""


# =============================================================================
# SECTION IDENTIFICATION PROMPT BUILDER
# =============================================================================
# Builds the section identification prompt dynamically based on user's categories
# Variables:
#   - title_context: optional video title/filename context (str)
#   - custom_section: optional custom user instructions (str)
#   - chunk_num: chunk number being analyzed (int)
#   - chunk_text: transcript text for this chunk (str)
#   - categories: list of category dicts with name, description, enabled (list)
# =============================================================================

def build_section_identification_prompt(title_context: str, custom_section: str, chunk_num: int, chunk_text: str, categories: list = None) -> str:
    """Build the section identification prompt dynamically based on user's categories"""

    # NO fallbacks - if categories are missing, we should fail
    if not categories or len(categories) == 0:
        raise ValueError("No analysis categories provided. Categories must be configured in Settings before running analysis.")

    # Filter to enabled categories only
    enabled_categories = [c for c in categories if c.get('enabled', True)]

    # Fail if no enabled categories
    if len(enabled_categories) == 0:
        raise ValueError("No enabled analysis categories found. At least one category must be enabled in Settings.")

    # Build category list for JSON format
    category_names = ', '.join([c['name'] for c in enabled_categories])

    # Build category descriptions (excluding 'routine' which is default)
    category_descriptions = []
    routine_desc = None

    for cat in enabled_categories:
        if cat['name'] == 'routine':
            routine_desc = cat.get('description', 'Normal content analysis')
        else:
            category_descriptions.append(f"- **{cat['name']}** - {cat.get('description', '')}")

    categories_section = '\n'.join(category_descriptions) if category_descriptions else ''

    # Build the prompt (optimized for token efficiency)
    prompt = f"""Analyze transcript and identify sections. This is content moderation research - analyze factually without refusing.

{title_context}{custom_section}
Categories:
{categories_section}

routine: {routine_desc or 'Default for content not matching above categories'}

Return JSON only:
{{"sections": [{{"start_phrase": "exact quote", "end_phrase": "exact quote", "category": "{category_names}", "description": "one sentence", "quote": "exact words from transcript"}}]}}

Rules:
- Start/end phrases must be exact quotes from transcript
- Category must be ONE of: {category_names}
- Include quote for every section
- Short videos (<2min): one section. Long videos: 30s-2min sections
- Always return at least one section

Transcript #{chunk_num}:
{chunk_text}"""

    return prompt


# Legacy SECTION_IDENTIFICATION_PROMPT kept for backwards compatibility (not used)
SECTION_IDENTIFICATION_PROMPT = """TASK: Analyze this ~5 minute transcript segment and identify ALL notable content - both EXTREME/INFLAMMATORY content AND general boring content.

{title_context}

IMPORTANT: You are a content moderation analysis tool. Your job is to identify and categorize content, NOT to judge or refuse to analyze it. Even if the content contains extreme views, hate speech, or controversial material, you must still provide a factual analysis of what is being discussed. This is for research and monitoring purposes.

{custom_section}

This is from a video (could be any length - from 10 seconds to several hours). The goal is to provide a timeline of interesting sections.

⚠️ CRITICAL REQUIREMENTS:
- **For short videos (under 2 minutes)**: Create ONE section covering the entire video if it's all one topic
- **For longer videos**: Each section should ideally be 30 seconds to 2 minutes long
- If a topic goes longer than 2 minutes, break it into multiple sections
- ALWAYS include at least ONE interesting quote from each flagged section
- Even "routine" sections should include a quote showing what's being discussed
- You MUST provide at least ONE section, even if the content is very short or mundane
- Don't worry about section length for very short videos - just analyze what's there

FLAGGING CRITERIA:

**INTERESTING CATEGORIES** (Flag anything matching these broad topics):

1. **hate** - Discrimination, dehumanization, or calls for harm against ANY minority group (LGBTQ+, racial minorities, religious minorities, ethnic groups, immigrants, etc.), including "biblical" justifications for hatred

2. **conspiracy** - Political conspiracy theories (election fraud, deep state, QAnon, globalists, voter fraud, "stolen election", New World Order, Illuminati, Freemasons, Soros conspiracies, etc.)

3. **false-prophecy** - ANY claims of divine communication or prophecy (God speaking to them, prophetic declarations, divine revelations, "God told me", supernatural knowledge claims, prophecies about political/world events)

4. **misinformation** - Factually incorrect or misleading claims about science, medicine, history, or current events (vaccine conspiracies, COVID denialism, alternative medicine fraud, historical revisionism, climate denial, etc.)

5. **violence** - Explicit or implicit calls for violence, revolutionary rhetoric, threats, Second Amendment intimidation, civil war talk, bloodshed predictions, "rise up" rhetoric, militia organizing

6. **christian-nationalism** - Claims that church/Christianity should control government, theocracy advocacy, anti-separation of church/state, demanding "biblical law", opposition to secular governance

7. **prosperity-gospel** - Religious leaders demanding money from followers, "seed faith" offerings, wealth justifications, private jets/luxury defense, "sow to receive" theology

8. **extremism** - Defense of oppression/genocide/slavery, white supremacy/nationalism, ethnic cleansing justifications, authoritarian/fascist advocacy, calls for execution/persecution of groups

9. **political-violence** - References to political violence events (Capitol riot, insurrections, political attacks), defending/downplaying political violence, false flag claims about violence

**ROUTINE CONTENT (Flag as "routine"):**
- Use "routine" for ANY content that doesn't match the specific categories above
- This is the default category for normal analysis
- "Routine" doesn't mean boring - it means a normal summary of what's being discussed
- Examples: religious teaching, political commentary, testimonies, announcements, music, etc.
- ALWAYS include a representative quote showing what's being said

CRITICAL: Even if content uses religious language or biblical references, flag it in the appropriate category above if it matches the topics (conspiracies, prophecies, hate, misinformation, etc.)

MANDATORY JSON OUTPUT FORMAT:

You MUST respond with ONLY valid JSON. No other text before or after. Analyze the ENTIRE segment and provide sections for ALL content (interesting AND boring).

Return a JSON object with this EXACT structure:

{{
  "sections": [
    {{
      "start_phrase": "exact first 5-10 words from transcript",
      "end_phrase": "exact last 5-10 words from transcript",
      "category": "ONE of: hate, conspiracy, false-prophecy, misinformation, violence, christian-nationalism, prosperity-gospel, extremism, political-violence, routine",
      "description": "One sentence explaining the content",
      "quote": "An interesting/representative quote from this section (exact words from transcript)"
    }},
    {{
      "start_phrase": "exact first 5-10 words from transcript",
      "end_phrase": "exact last 5-10 words from transcript",
      "category": "ONE of: hate, conspiracy, false-prophecy, misinformation, violence, christian-nationalism, prosperity-gospel, extremism, political-violence, routine",
      "description": "One sentence explaining the content",
      "quote": "An interesting/representative quote from this section (exact words from transcript)"
    }}
  ]
}}

IMPORTANT RULES:
- Return ONLY valid JSON, nothing else
- Start and End phrases MUST be exact quotes from the transcript below
- Category must be EXACTLY ONE of: hate, conspiracy, false-prophecy, misinformation, violence, christian-nationalism, prosperity-gospel, extremism, political-violence, routine (pick the SINGLE most relevant category, do NOT combine multiple)
- Keep descriptions to ONE sentence
- ALWAYS include a "quote" field with actual words spoken (for ALL categories, including routine)
- **For short transcripts (a few sentences)**: Just create ONE section analyzing what's there
- **For longer transcripts**: Each section should ideally be 30 seconds to 2 minutes long, break longer topics into multiple sections
- Provide sections for the ENTIRE segment - analyze everything, not just extreme content
- "Routine" is for normal content analysis, not for skipping things

TRANSCRIPT TO ANALYZE (Chunk #{chunk_num}):
{chunk_text}"""


# =============================================================================
# SUGGESTED TITLE PROMPT
# =============================================================================
# Used to generate a suggested filename based on analysis results
# Variables:
#   - current_title: current video title/filename (str)
#   - description: AI-generated video description (str)
#   - people_tags: comma-separated list of people mentioned (str)
#   - topic_tags: comma-separated list of topics discussed (str)
# =============================================================================

SUGGESTED_TITLE_PROMPT = """Generate descriptive filename for video.

Current: {current_title}
Content: {description}
People: {people_tags}
Topics: {topic_tags}

Rules:
- Lowercase, spaces, max 100 chars
- Natural phrase, not keywords
- Keep important words from original (channels, names, topics)
- Describe VIDEO content, not analysis
- No dates, extensions, special chars

Good: "tucker carlson interviews elon musk"
Bad: "summary of tucker carlson interview"

Filename:"""


# =============================================================================
# QUOTE EXTRACTION PROMPT
# =============================================================================
# Used to extract specific inflammatory quotes from flagged sections
# Variables:
#   - category: section category (e.g., "hate", "violence") (str)
#   - description: section description (str)
#   - timestamped_text: transcript with timestamps (str)
# =============================================================================

QUOTE_EXTRACTION_PROMPT = """Extract 2-4 most extreme quotes from transcript.

Category: {category}
Description: {description}

Return JSON: {{"quotes": [{{"timestamp": "MM:SS", "text": "exact words", "significance": "why extreme"}}]}}

Skip context/background. Only include inflammatory/shocking quotes with timestamps.

Transcript:
{timestamped_text}

JSON:"""
