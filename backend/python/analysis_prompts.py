"""
AI Analysis Prompts for Clippy Video Analysis

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

VIDEO_SUMMARY_PROMPT = """Provide a brief 2-3 sentence summary of this video based on the analysis of its content.{title_context}
Focus on: What is the video about? What are the main topics/subjects? Who is speaking (if identifiable)?

Use the video title/filename as additional context to help identify the subject matter and people involved.

Below is a timeline of sections identified throughout the video. Synthesize this into a concise overview:

{sections_summary}

Provide a 2-3 sentence summary:"""


# =============================================================================
# TAG EXTRACTION PROMPT
# =============================================================================
# Used to extract people names and topics from the video
# Variables:
#   - sections_context: summary of analyzed section descriptions (str)
#   - excerpt: transcript excerpt for tag extraction (str)
# =============================================================================

TAG_EXTRACTION_PROMPT = """Analyze this video transcript and extract tags for categorization.

TASK: Extract two types of tags:
1. **PEOPLE**: Names of specific individuals mentioned or speaking (e.g., "Donald Trump", "Mike Lindell", "Greg Locke")
2. **TOPICS**: Main topics, themes, or subjects discussed (e.g., "COVID-19", "Election", "Prophecy", "Vaccines")

RULES:
- Return ONLY valid JSON, nothing else
- For people: Only extract proper names of real individuals (not generic terms like "doctor" or "pastor")
- For topics: Extract 3-8 main topics or themes
- Use title case for names (e.g., "Joe Biden" not "joe biden")
- Keep topic tags concise (1-3 words max)

JSON FORMAT:
{{
  "people": ["Name One", "Name Two", ...],
  "topics": ["Topic One", "Topic Two", ...]
}}

Section analysis context:
{sections_context}

Transcript excerpt:
{excerpt}

Tags (JSON only):"""


# =============================================================================
# SECTION IDENTIFICATION PROMPT
# =============================================================================
# Used to identify interesting/notable sections in video chunks
# Variables:
#   - title_context: optional video title/filename context (str)
#   - custom_section: optional custom user instructions (str)
#   - chunk_num: chunk number being analyzed (int)
#   - chunk_text: transcript text for this chunk (str)
# =============================================================================

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
      "category": "hate|conspiracy|false-prophecy|misinformation|violence|christian-nationalism|prosperity-gospel|extremism|political-violence|routine",
      "description": "One sentence explaining the content",
      "quote": "An interesting/representative quote from this section (exact words from transcript)"
    }},
    {{
      "start_phrase": "exact first 5-10 words from transcript",
      "end_phrase": "exact last 5-10 words from transcript",
      "category": "hate|conspiracy|false-prophecy|misinformation|violence|christian-nationalism|prosperity-gospel|extremism|political-violence|routine",
      "description": "One sentence explaining the content",
      "quote": "An interesting/representative quote from this section (exact words from transcript)"
    }}
  ]
}}

IMPORTANT RULES:
- Return ONLY valid JSON, nothing else
- Start and End phrases MUST be exact quotes from the transcript below
- Categories: hate, conspiracy, false-prophecy, misinformation, violence, christian-nationalism, prosperity-gospel, extremism, political-violence, OR routine
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

SUGGESTED_TITLE_PROMPT = """Based on the AI analysis of this video, suggest a better, more descriptive filename.

**Current Title:** {current_title}

**Video Description:** {description}

**People Mentioned:** {people_tags}

**Topics Discussed:** {topic_tags}

**Requirements:**
- Use lowercase with spaces (NOT hyphens) between words
- Be descriptive and keyword-rich to aid in searching
- Include the most important person's name if applicable
- Describe the main topic, action, or claim
- **IMPORTANT: Use commas (,) to separate lists of names, items, or topics**
- Use dashes (single hyphen with spaces around it " - ") for elaboration or additional context
- Can be long and detailed (no strict character limit, but keep it reasonable)
- NO special characters: no periods, quotes, slashes, or other symbols
- You may use "etc" at the end without a period if listing many items
- DO NOT include date or file extension
- Add "(full)" at the end if this is a complete, unedited video
- Return ONLY the suggested title, nothing else

**Examples showing proper comma usage:**
- When listing people: "george washington, abraham lincoln, christopher columbus"
- When listing groups: "jews, ethnic minorities, lgbtq people"
- When listing topics: "election fraud, qanon, deep state conspiracy"

Examples of good titles:
- "greg locke prophesies that the conservative movement will be split on jew hate, and tucker carlson is where it starts, after interviewing nick fuentes"
- "joel webbon says women are atrocious today - theyre hoes, stupid, deceitful, wicked, vile, vote for trans people, etc"
- "joshua haymes says a satanic statue was being erected in the state capitol, but this extremist destroyed one, and he should be honored for that - michael cassidy"
- "tucker carlson interviews nick fuentes - ben shapiro was not happy - new york times claims fuentes is replacing charlie kirk (full)"
- "nick fuentes releases antisemitic video praising racist figures - george washington, abraham lincoln, christopher columbus - hate speech promoting discrimination against jews, ethnic minorities, etc"

Bad examples:
- "greg-locke-election-fraud" (uses hyphens instead of spaces)
- "Video about politics" (too generic, has capital letter)
- "Greg Locke's speech." (has capitals and period)
- "2021-08-15 sermon.mp4" (includes date and extension)

Suggested title:"""


# =============================================================================
# QUOTE EXTRACTION PROMPT
# =============================================================================
# Used to extract specific inflammatory quotes from flagged sections
# Variables:
#   - category: section category (e.g., "hate", "violence") (str)
#   - description: section description (str)
#   - timestamped_text: transcript with timestamps (str)
# =============================================================================

QUOTE_EXTRACTION_PROMPT = """Analyze this timestamped transcript section and extract ONLY the most extreme/inflammatory quotes.

Category: {category}
Description: {description}

IMPORTANT: Only extract quotes that are themselves extreme, inflammatory, or shocking. Skip:
- Context-setting or background information
- Normal explanations or introductions
- Mild statements or routine content

Extract 2-4 key quotes that capture the MOST extreme parts. For each quote:
1. Include the exact timestamp [MM:SS]
2. Quote the exact words spoken (the inflammatory part)
3. Explain why it's extreme/concerning (1-2 sentences)

MANDATORY JSON OUTPUT FORMAT:

You MUST respond with ONLY valid JSON. No other text before or after.

Return a JSON object with this EXACT structure:

{{
  "quotes": [
    {{
      "timestamp": "MM:SS",
      "text": "exact inflammatory words from transcript",
      "significance": "Why this is extreme/concerning (1-2 sentences)"
    }},
    {{
      "timestamp": "MM:SS",
      "text": "exact inflammatory words from transcript",
      "significance": "Why this is extreme/concerning (1-2 sentences)"
    }}
  ]
}}

IMPORTANT RULES:
- Return ONLY valid JSON, nothing else
- Timestamp must be in MM:SS or HH:MM:SS format
- Quote must be exact words from the transcript
- Significance should be 1-2 sentences explaining why it's extreme

TIMESTAMPED TRANSCRIPT:
{timestamped_text}"""
