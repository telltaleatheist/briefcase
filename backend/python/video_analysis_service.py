#!/usr/bin/env python3
"""
Video Analysis Service for ClipChimp
Handles transcription and AI analysis using Whisper and Ollama
"""

import sys
import json
import os
import time
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional

# CRITICAL: Add script directory to sys.path BEFORE importing sibling modules
# This is needed because Windows embedded Python ignores PYTHONPATH
# The ._pth file in embedded Python overrides all path settings
_script_dir = os.path.dirname(os.path.abspath(__file__))
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

import requests

# Import AI prompts from configuration file
from analysis_prompts import (
    VIDEO_SUMMARY_PROMPT,
    TAG_EXTRACTION_PROMPT,
    QUOTE_EXTRACTION_PROMPT,
    SUGGESTED_TITLE_PROMPT,
    build_section_identification_prompt
)

# Try to import OpenAI client (optional dependency)
try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

# Try to import Anthropic client (optional dependency)
try:
    from anthropic import Anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


def send_progress(phase: str, progress: float, message: str):
    """Send progress update to Node.js via stdout"""
    progress_data = {
        "type": "progress",
        "phase": phase,
        "progress": progress,
        "message": message
    }
    print(json.dumps(progress_data), flush=True)


def send_error(error_message: str):
    """Send error to Node.js via stdout"""
    error_data = {
        "type": "error",
        "message": error_message
    }
    print(json.dumps(error_data), flush=True)


def send_result(result: Dict[str, Any]):
    """Send final result to Node.js via stdout"""
    result_data = {
        "type": "result",
        "data": result
    }
    print(json.dumps(result_data), flush=True)


def transcribe_audio(audio_path: str, model: str = "base", language: str = "en") -> Dict[str, Any]:
    """
    Transcribe audio using Whisper
    Uses the fastest settings for speed over quality
    Default model is 'base' - good balance of speed and accuracy
    """
    try:
        import whisper
        import os

        send_progress("transcription", 0, f"Loading Whisper model ({model})...")

        # Set cache directory to use bundled model if available
        # In production, models are bundled in python/cache/whisper/
        python_dir = os.path.dirname(sys.executable)
        bundled_cache = os.path.join(python_dir, 'cache', 'whisper')

        print(f"[DEBUG] Python executable: {sys.executable}", file=sys.stderr)
        print(f"[DEBUG] Checking for bundled cache: {bundled_cache}", file=sys.stderr)

        # Load model with speed optimizations
        if os.path.exists(bundled_cache):
            # Use bundled model
            print(f"[DEBUG] Using bundled Whisper models from {bundled_cache}", file=sys.stderr)
            os.environ['XDG_CACHE_HOME'] = os.path.join(python_dir, 'cache')
            whisper_model = whisper.load_model(
                model,
                device="cpu",  # Force CPU for compatibility
                in_memory=True,
                download_root=bundled_cache
            )
        else:
            # Download to user cache if needed
            print(f"[DEBUG] Bundled cache not found, will download to user cache", file=sys.stderr)
            whisper_model = whisper.load_model(
                model,
                device="cpu",  # Force CPU for compatibility
                in_memory=True
            )

        send_progress("transcription", 10, "Transcribing audio (this may take a few minutes)...")

        # Transcribe with fastest settings
        # Whisper automatically outputs progress to stderr via tqdm
        # The backend (python-bridge.service.ts) parses this output
        result = whisper_model.transcribe(
            audio_path,
            language=language,
            verbose=False,
            fp16=False,  # Disable FP16 for CPU
            # Speed optimizations
            beam_size=1,  # Faster decoding
            best_of=1,    # Single pass
            temperature=0  # Deterministic output
        )

        send_progress("transcription", 95, "Transcription complete, formatting results...")

        # Generate SRT content
        srt_content = generate_srt(result['segments'])

        send_progress("transcription", 100, "Transcription complete!")

        return {
            "text": result['text'],
            "segments": result['segments'],
            "srt": srt_content,
            "language": result.get('language', language)
        }

    except ImportError:
        send_error("Whisper not installed. Please install: pip install openai-whisper")
        raise
    except Exception as e:
        send_error(f"Transcription failed: {str(e)}")
        raise


def generate_srt(segments: List[Dict]) -> str:
    """Generate SRT subtitle format from Whisper segments"""
    srt_lines = []

    for i, segment in enumerate(segments, 1):
        start_time = format_timestamp(segment['start'])
        end_time = format_timestamp(segment['end'])
        text = segment['text'].strip()

        srt_lines.append(f"{i}")
        srt_lines.append(f"{start_time} --> {end_time}")
        srt_lines.append(text)
        srt_lines.append("")  # Empty line between segments

    return "\n".join(srt_lines)


def format_timestamp(seconds: float) -> str:
    """Format timestamp for SRT format (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millisecs = int((seconds % 1) * 1000)

    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millisecs:03d}"


def check_ollama_model(endpoint: str, model: str) -> bool:
    """
    Check if Ollama model is available and can respond
    Uses ContentStudio's approach: actually test the model with a simple request
    """
    import time
    start_time = time.time()

    try:
        print(f"[Model Check] Testing availability for: {model}", file=sys.stderr)
        print(f"[Model Check] Ollama endpoint: {endpoint}", file=sys.stderr)
        print(f"[Model Check] Timeout: 300 seconds (5 minutes)", file=sys.stderr)

        # First check if Ollama server is reachable
        print(f"[Model Check] Step 1: Checking Ollama server connection...", file=sys.stderr)
        try:
            response = requests.get(f"{endpoint}/api/tags", timeout=5)
            if response.status_code != 200:
                print(f"[Model Check] ✗ Ollama server returned HTTP {response.status_code}", file=sys.stderr)
                send_error(f"Ollama server at {endpoint} returned HTTP {response.status_code}")
                return False

            print(f"[Model Check] ✓ Ollama server is reachable (HTTP {response.status_code})", file=sys.stderr)

            # List available models for debugging
            try:
                data = response.json()
                models = data.get('models', [])
                model_names = [m.get('name', '') for m in models if isinstance(m, dict)]
                print(f"[Model Check] Available models in Ollama: {', '.join(model_names)}", file=sys.stderr)

                # Check if model name exists in list
                model_exists = model in model_names or f"{model}:latest" in model_names
                if not model_exists:
                    print(f"[Model Check] ⚠ Model '{model}' not in model list, but will try to use it anyway", file=sys.stderr)
                    # Don't fail here - the model might still work
                else:
                    print(f"[Model Check] ✓ Model '{model}' found in Ollama model list", file=sys.stderr)
            except (ValueError, KeyError, TypeError) as e:
                # If we can't parse the model list, just log a warning and continue
                # The model test in Step 2 will verify if it actually works
                print(f"[Model Check] ⚠ Could not parse model list: {str(e)}", file=sys.stderr)
                print(f"[Model Check] Will try to use model anyway and see if it responds", file=sys.stderr)

        except requests.exceptions.ConnectionError as e:
            print(f"[Model Check] ✗ Cannot connect to Ollama server at {endpoint}", file=sys.stderr)
            print(f"[Model Check] Error: {str(e)}", file=sys.stderr)
            print(f"[Model Check] Make sure Ollama is running (try: ollama serve)", file=sys.stderr)
            send_error(f"Cannot connect to Ollama at {endpoint}. Make sure Ollama is running.")
            return False

        # Now test the model by actually trying to use it
        # This ensures the model can load and respond, not just that it exists
        print(f"[Model Check] Step 2: Testing model response with generate request...", file=sys.stderr)
        test_response = requests.post(
            f"{endpoint}/api/generate",
            json={
                "model": model,
                "prompt": "Ready.",
                "stream": False,
                "keep_alive": "5m",  # Keep model loaded for 5 minutes after check
                "options": {"num_predict": 5}
            },
            timeout=300  # 300 seconds (5 minutes) to allow large model loading
        )

        elapsed_time = time.time() - start_time

        if test_response.status_code == 200:
            try:
                response_data = test_response.json()
                print(f"[Model Check] ✓ Model '{model}' is available and responding (took {elapsed_time:.1f}s)", file=sys.stderr)
                response_preview = str(response_data)[:100]
                print(f"[Model Check] Response: {response_preview}...", file=sys.stderr)
                return True
            except (ValueError, TypeError) as e:
                print(f"[Model Check] ⚠ Model responded but JSON was malformed: {str(e)}", file=sys.stderr)
                print(f"[Model Check] Response text: {test_response.text[:200]}", file=sys.stderr)
                # Consider it successful if we got a 200 response, even if JSON parsing failed
                return True
        else:
            print(f"[Model Check] ✗ Model '{model}' returned unexpected status {test_response.status_code}", file=sys.stderr)
            try:
                error_data = test_response.json()
                error_msg = error_data.get('error', str(error_data))
                print(f"[Model Check] Error response: {error_msg}", file=sys.stderr)
                send_error(f"Model '{model}' failed: {error_msg}")
            except (ValueError, TypeError):
                error_text = test_response.text[:500] if test_response.text else 'No response body'
                print(f"[Model Check] Raw error response: {error_text}", file=sys.stderr)
                send_error(f"Model '{model}' failed to respond: HTTP {test_response.status_code}")
            return False

    except requests.exceptions.Timeout:
        elapsed_time = time.time() - start_time
        print(f"[Model Check] ✗ Model '{model}' loading timed out after {elapsed_time:.1f}s", file=sys.stderr)
        print(f"[Model Check] This model may be too large or Ollama may be busy", file=sys.stderr)
        print(f"[Model Check] Try a smaller model like qwen2.5:7b or llama3.2:3b", file=sys.stderr)
        send_error(f"Model '{model}' loading timed out after {elapsed_time:.1f}s. Try a smaller model.")
        return False
    except Exception as e:
        elapsed_time = time.time() - start_time
        print(f"[Model Check] ✗ Error checking model '{model}': {str(e)}", file=sys.stderr)
        print(f"[Model Check] Error type: {type(e).__name__}", file=sys.stderr)
        send_error(f"Cannot connect to Ollama or load model '{model}': {str(e)}")
        return False


def generate_video_summary_from_sections(provider: str, endpoint_or_key: str, model: str, analyzed_sections: List[Dict], video_title: str = "") -> str:
    """Generate a video summary based on analyzed sections (covers the entire video)"""
    try:
        # Handle edge case where there are no sections
        if not analyzed_sections or len(analyzed_sections) == 0:
            return "No content could be analyzed in this video."

        # Build sections summary from all analyzed sections
        sections_list = []
        for i, section in enumerate(analyzed_sections[:20], 1):  # Use first 20 sections to avoid token limits
            category = section.get('category', 'unknown')
            description = section.get('description', 'No description')
            start_time = section.get('start_time', '?')

            # Format: "1. [0:00] Description [category]"
            sections_list.append(f"{i}. [{start_time}] {description} [{category}]")

        sections_summary = "\n".join(sections_list)

        # Build the prompt with optional title context
        title_context = f"\nVideo title/filename: {video_title}\n" if video_title else ""

        prompt = VIDEO_SUMMARY_PROMPT.format(
            title_context=title_context,
            sections_summary=sections_summary
        )

        response = call_ai(provider, endpoint_or_key, model, prompt, timeout=60)

        if response:
            return response.strip()
        else:
            # Fallback: create summary from section descriptions
            routine_count = sum(1 for s in analyzed_sections if s.get('category') == 'routine')
            interesting_count = len(analyzed_sections) - routine_count

            if interesting_count == 0:
                return "This video contains routine content with no particularly notable sections identified."
            else:
                categories = [s.get('category') for s in analyzed_sections if s.get('category') != 'routine']
                category_summary = ", ".join(set(categories))
                return f"This video contains {interesting_count} notable section(s) including: {category_summary}."

    except Exception as e:
        print(f"[DEBUG] Summary generation failed: {e}", file=sys.stderr)
        return "Summary could not be generated for this video."


def prepend_summary_to_file(output_file: str, summary: str):
    """Prepend the video overview section to the analysis file"""
    try:
        # Read existing content
        with open(output_file, 'r', encoding='utf-8') as f:
            existing_content = f.read()

        # Write summary + existing content
        with open(output_file, 'w', encoding='utf-8') as f:
            # Find the end of the header
            header_end = existing_content.find("\n\n")
            if header_end != -1:
                # Insert summary after header
                header = existing_content[:header_end + 2]
                rest = existing_content[header_end + 2:]

                f.write(header)
                f.write("**VIDEO OVERVIEW**\n\n")
                f.write(summary + "\n\n")
                f.write("-" * 80 + "\n\n")
                f.write(rest)
            else:
                # Fallback: just prepend
                f.write("**VIDEO OVERVIEW**\n\n")
                f.write(summary + "\n\n")
                f.write("-" * 80 + "\n\n")
                f.write(existing_content)

            f.flush()
    except Exception as e:
        print(f"[WARNING] Could not prepend summary to file: {e}", file=sys.stderr)


def extract_tags(provider: str, endpoint_or_key: str, model: str, transcript_text: str, analyzed_sections: List[Dict]) -> Dict[str, List[str]]:
    """Extract people names and topics from the transcript and analysis"""
    try:
        # Create a summary of the content for tag extraction
        excerpt = transcript_text[:3000] if len(transcript_text) > 3000 else transcript_text

        # Collect section descriptions for context
        section_descriptions = [s.get('description', '') for s in analyzed_sections if s.get('description')]
        sections_context = " ".join(section_descriptions[:10])  # First 10 sections

        prompt = TAG_EXTRACTION_PROMPT.format(
            sections_context=sections_context,
            excerpt=excerpt
        )

        response = call_ai(provider, endpoint_or_key, model, prompt, timeout=60)

        if response:
            # Try to parse JSON response
            try:
                # Clean up response - sometimes AI adds markdown code blocks
                clean_response = response.strip()
                if clean_response.startswith('```'):
                    # Remove markdown code block markers
                    lines = clean_response.split('\n')
                    clean_response = '\n'.join([l for l in lines if not l.startswith('```')])

                tags_data = json.loads(clean_response)

                # Validate structure
                if 'people' in tags_data and 'topics' in tags_data:
                    return {
                        'people': tags_data['people'][:20],  # Limit to 20 people
                        'topics': tags_data['topics'][:15]   # Limit to 15 topics
                    }
                else:
                    print(f"[WARNING] Tag extraction returned invalid format", file=sys.stderr)
                    return {'people': [], 'topics': []}

            except json.JSONDecodeError as e:
                print(f"[WARNING] Failed to parse tag extraction JSON: {e}", file=sys.stderr)
                print(f"[WARNING] Raw response: {response[:200]}", file=sys.stderr)
                return {'people': [], 'topics': []}
        else:
            print(f"[WARNING] Tag extraction returned empty response", file=sys.stderr)
            return {'people': [], 'topics': []}

    except Exception as e:
        print(f"[WARNING] Tag extraction failed: {e}", file=sys.stderr)
        return {'people': [], 'topics': []}


def generate_suggested_title(provider: str, endpoint_or_key: str, model: str, current_title: str, description: str, tags: Dict[str, List[str]]) -> Optional[str]:
    """Generate a suggested filename based on analysis results"""
    try:
        # Format tags for the prompt
        people_tags = ', '.join(tags.get('people', [])[:5]) if tags.get('people') else 'None'
        topic_tags = ', '.join(tags.get('topics', [])[:5]) if tags.get('topics') else 'None'

        prompt = SUGGESTED_TITLE_PROMPT.format(
            current_title=current_title,
            description=description[:500],  # Limit description length
            people_tags=people_tags,
            topic_tags=topic_tags
        )

        response = call_ai(provider, endpoint_or_key, model, prompt, timeout=30)

        if response:
            # Clean up the response
            suggested_title = response.strip()

            # Remove any quotes or extra text
            if suggested_title.startswith('"') and suggested_title.endswith('"'):
                suggested_title = suggested_title[1:-1]

            # Remove any file extension if AI added it
            if '.' in suggested_title:
                suggested_title = suggested_title.split('.')[0]

            # Remove any date prefix if AI added it
            import re
            suggested_title = re.sub(r'^\d{4}-\d{2}-\d{2}[-\s]*', '', suggested_title)

            # Ensure it's lowercase and clean
            suggested_title = suggested_title.lower().strip()

            # Remove invalid filesystem characters but keep spaces, commas, dashes, and parentheses
            # Invalid chars on most filesystems: / \ : * ? " < > |
            suggested_title = re.sub(r'[/\\:*?"<>|]', '', suggested_title)

            # Remove periods except in "(full)" or "etc"
            suggested_title = re.sub(r'\.(?!\s|$)', '', suggested_title)  # Remove periods not at end
            suggested_title = re.sub(r'\.$', '', suggested_title)  # Remove trailing period

            # Clean up multiple spaces
            suggested_title = re.sub(r'\s+', ' ', suggested_title)
            suggested_title = suggested_title.strip()

            # Reasonable length limit (200 chars to avoid filesystem issues)
            if len(suggested_title) > 200:
                suggested_title = suggested_title[:200].rsplit(',', 1)[0]  # Cut at last comma
                if len(suggested_title) > 200:  # Still too long, cut at last space
                    suggested_title = suggested_title[:200].rsplit(' ', 1)[0]

            print(f"[DEBUG] Generated suggested title: {suggested_title}", file=sys.stderr)
            return suggested_title if suggested_title else None
        else:
            return None

    except Exception as e:
        print(f"[WARNING] Suggested title generation failed: {e}", file=sys.stderr)
        return None


def analyze_with_ai(
    provider: str,
    endpoint_or_key: str,
    model: str,
    transcript_text: str,
    segments: List[Dict],
    output_file: str,
    custom_instructions: str = "",
    video_title: str = "",
    categories: List[Dict] = None
) -> Dict[str, Any]:
    """
    Analyze transcript using AI model (Ollama, OpenAI, or Claude)
    Chunks the transcript and streams analysis results
    """
    try:
        send_progress("analysis", 0, f"Starting AI analysis with {model}...")

        # Check model availability (only for Ollama)
        if provider == 'ollama':
            if not check_ollama_model(endpoint_or_key, model):
                raise Exception(f"Model '{model}' not found in Ollama. Please install it first.")

        # Write header to file (summary will be added at the end after analysis)
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write("=" * 80 + "\n")
            f.write("VIDEO ANALYSIS RESULTS\n")
            f.write("=" * 80 + "\n\n")
            f.flush()

        # Chunk transcript into time-based segments (5 min chunks for more granular analysis)
        chunks = chunk_transcript(segments, chunk_minutes=5)

        # Send initial progress indicating total chunks
        # If only 1 chunk, we'll use indeterminate progress (progress=-1)
        total_chunks = len(chunks)
        if total_chunks == 1:
            send_progress("analysis", -1, f"Analyzing video...")
        else:
            send_progress("analysis", 0, f"Starting analysis of {total_chunks} chunks...")

        analyzed_sections = []
        failed_chunks = []
        completed_chunks = 0

        for i, chunk in enumerate(chunks, 1):
            # Identify interesting sections - with error handling to skip failed chunks
            try:
                interesting_sections = identify_interesting_sections(
                    provider, endpoint_or_key, model, chunk['text'], i, custom_instructions, video_title, categories
                )
            except Exception as e:
                # Log the failure but continue with remaining chunks
                print(f"[WARNING] Chunk {i} failed after retries: {e}", file=sys.stderr)
                print(f"[WARNING] Skipping chunk {i} and continuing with remaining chunks...", file=sys.stderr)
                failed_chunks.append(i)
                completed_chunks += 1
                # Send progress update for completed (but failed) chunk
                if total_chunks > 1:
                    chunk_progress = round((completed_chunks / total_chunks) * 100)
                    send_progress("analysis", chunk_progress, f"Chunk {i} failed, continuing... ({completed_chunks}/{total_chunks})")
                continue  # Skip this chunk, move to next one

            if interesting_sections:

                # Process each section
                for section in interesting_sections:
                    # For routine sections, just add with the quote from initial analysis
                    if section.get('category') == 'routine':
                        # Find approximate timestamps
                        start_phrase = section.get('start_phrase', '')
                        start_time = find_phrase_timestamp(start_phrase, chunk['segments'])

                        if start_time is not None:
                            # Get the quote from the section (AI should provide it)
                            quote_text = section.get('quote', '')
                            quotes = []
                            if quote_text:
                                quotes = [{
                                    "timestamp": format_display_time(start_time),
                                    "text": quote_text,
                                    "significance": section.get('description', '')
                                }]

                            analyzed_sections.append({
                                "category": "routine",
                                "description": section['description'],
                                "start_time": format_display_time(start_time),
                                "end_time": None,
                                "quotes": quotes
                            })
                            # Write immediately (is_first=False since we already wrote header with summary)
                            write_section_to_file(output_file, analyzed_sections[-1], is_first=False)
                    else:
                        # For interesting sections, do detailed analysis
                        detailed_analysis = analyze_section_detail(
                            provider, endpoint_or_key, model, section, chunk['segments']
                        )
                        if detailed_analysis:
                            analyzed_sections.append(detailed_analysis)
                            # Write section immediately to file (streaming, is_first=False since we already wrote header)
                            write_section_to_file(output_file, detailed_analysis, is_first=False)

            # Chunk processing complete - update progress
            completed_chunks += 1
            if total_chunks > 1:
                chunk_progress = round((completed_chunks / total_chunks) * 100)
                send_progress("analysis", chunk_progress, f"Completed chunk {i}/{total_chunks}")

        # Report completion with chunk failure information
        if failed_chunks:
            send_progress("analysis", 100, f"Analysis complete with {len(failed_chunks)} failed chunks. Found {len(analyzed_sections)} sections.")
            print(f"[WARNING] Analysis completed but {len(failed_chunks)} chunks failed: {failed_chunks}", file=sys.stderr)
        else:
            send_progress("analysis", 100, f"Analysis complete. Found {len(analyzed_sections)} sections.")

        # Final safety check: if we have NO sections at all, create a default "routine" section
        if len(analyzed_sections) == 0:
            print(f"[WARNING] Analysis produced zero sections! Creating default routine section.", file=sys.stderr)
            print(f"[WARNING] Chunks processed: {len(chunks)}", file=sys.stderr)
            print(f"[WARNING] Video duration: {segments[-1]['end'] if segments else 0}s", file=sys.stderr)

            # Determine why there are no sections
            video_duration = segments[-1]['end'] if segments else 0
            transcript_length = len(transcript_text.strip())

            if transcript_length == 0:
                description = "No speech or dialogue detected in this video. The video may contain only music, sound effects, or be silent."
            elif transcript_length < 50:
                description = "Very brief or minimal audio content detected. The video appears to have little to no meaningful dialogue."
            elif any(word in transcript_text.lower() for word in ['music', '[music]', '[sound]', '[noise]']):
                description = "Video primarily contains music or ambient audio with minimal speech content."
            else:
                description = "Analysis could not identify specific notable sections. The content appears to be general discussion or routine material."

            # Create a default "routine" section covering the entire video
            default_section = {
                "category": "routine",
                "description": description,
                "start_time": "0:00",
                "end_time": format_display_time(video_duration) if video_duration > 0 else None,
                "quotes": []
            }

            analyzed_sections.append(default_section)

            # Write the default section to the file
            try:
                write_section_to_file(output_file, default_section, is_first=False)
            except Exception as e:
                print(f"[ERROR] Failed to write default section to output file: {e}", file=sys.stderr)

        # Extract tags from the full transcript and analysis
        send_progress("analysis", 92, "Extracting tags (people, topics)...")
        tags = extract_tags(provider, endpoint_or_key, model, transcript_text, analyzed_sections)

        # Generate video summary from analyzed sections (happens AFTER full analysis)
        send_progress("analysis", 95, "Generating video summary...")
        video_duration = segments[-1]['end'] if segments else 0
        summary = generate_video_summary_from_sections(provider, endpoint_or_key, model, analyzed_sections, video_title)

        # Prepend summary to the output file
        prepend_summary_to_file(output_file, summary)

        # Generate suggested title based on analysis
        send_progress("analysis", 98, "Generating suggested title...")
        suggested_title = generate_suggested_title(provider, endpoint_or_key, model, video_title, summary, tags)

        send_progress("analysis", 100, "Analysis complete!")

        return {
            "sections_count": len(analyzed_sections),
            "sections": analyzed_sections,
            "tags": tags,
            "description": summary,  # Add the summary as description for the video
            "suggested_title": suggested_title  # Add the suggested title
        }

    except Exception as e:
        send_error(f"AI analysis failed: {str(e)}")
        raise


def chunk_transcript(segments: List[Dict], chunk_minutes: int = 15) -> List[Dict]:
    """Split transcript into time-based chunks"""
    chunks = []
    chunk_duration = chunk_minutes * 60

    if not segments:
        return []

    total_duration = segments[-1]['end']
    current_start = 0
    chunk_num = 1

    while current_start < total_duration:
        chunk_end = current_start + chunk_duration

        # Get segments in this time range
        chunk_segments = [
            seg for seg in segments
            if seg['start'] >= current_start and seg['start'] < chunk_end
        ]

        if chunk_segments:
            chunk_text = ' '.join([seg['text'].strip() for seg in chunk_segments])
            chunks.append({
                'number': chunk_num,
                'start_time': current_start,
                'end_time': min(chunk_end, total_duration),
                'text': chunk_text,
                'segments': chunk_segments
            })
            chunk_num += 1

        current_start = chunk_end

    return chunks


def identify_interesting_sections(provider: str, endpoint_or_key: str, model: str, chunk_text: str, chunk_num: int, custom_instructions: str = "", video_title: str = "", categories: List[Dict] = None) -> List[Dict]:
    """Use AI to identify interesting sections in a chunk - with retry logic"""
    MAX_RETRIES = 3

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            print(f"[DEBUG] Analyzing chunk {chunk_num}, attempt {attempt}/{MAX_RETRIES}", file=sys.stderr)

            # Build title context section if provided
            title_context = ""
            if video_title and video_title.strip():
                title_context = f"""
**VIDEO CONTEXT:**
Video title/filename: {video_title.strip()}

Use the video title as additional context to understand who is speaking and what the subject matter is. For example, if the title mentions specific names or organizations, incorporate that information into your analysis.

"""

            # Build custom instructions section if provided
            custom_section = ""
            if custom_instructions and custom_instructions.strip():
                custom_section = f"""
**CUSTOM USER INSTRUCTIONS:**
{custom_instructions.strip()}

Pay special attention to the custom instructions above when analyzing the content. In addition to the standard flagging criteria below, prioritize identifying content that matches the user's specific requests.

"""

            # Build prompt dynamically with user's categories
            prompt = build_section_identification_prompt(
                title_context=title_context,
                custom_section=custom_section,
                chunk_num=chunk_num,
                chunk_text=chunk_text[:8000],  # Limit to ~8k chars for speed
                categories=categories
            )

            # Use very large timeout (30 minutes) - we don't care about timeout
            response = call_ai(provider, endpoint_or_key, model, prompt, timeout=1800)

            if not response:
                print(f"[WARNING] AI returned empty response for chunk {chunk_num} on attempt {attempt}", file=sys.stderr)
                if attempt < MAX_RETRIES:
                    print(f"[INFO] Retrying chunk {chunk_num}...", file=sys.stderr)
                    continue
                else:
                    raise Exception(f"Failed to get AI response after {MAX_RETRIES} attempts")

            # Check for content policy refusals
            refusal_indicators = [
                "I cannot", "I can't", "I'm not able to",
                "I don't feel comfortable", "I apologize, but",
                "against my guidelines", "content policy",
                "I'm designed to", "I shouldn't"
            ]

            if any(indicator.lower() in response.lower()[:200] for indicator in refusal_indicators):
                print(f"[WARNING] AI may have refused to analyze chunk {chunk_num}. Response starts with: {response[:200]}", file=sys.stderr)
                if attempt < MAX_RETRIES:
                    print(f"[INFO] Retrying chunk {chunk_num} due to content policy refusal...", file=sys.stderr)
                    continue
                else:
                    raise Exception(f"AI refused to analyze chunk {chunk_num} after {MAX_RETRIES} attempts")

            # Parse the response
            sections = parse_section_response(response)

            # If parsing succeeded and we got sections, return them
            if sections:
                print(f"[SUCCESS] Chunk {chunk_num} analyzed successfully on attempt {attempt}", file=sys.stderr)
                return sections

            # If parsing failed, retry
            print(f"[WARNING] Failed to parse any sections from AI response for chunk {chunk_num} on attempt {attempt}", file=sys.stderr)
            if attempt < MAX_RETRIES:
                print(f"[INFO] Retrying chunk {chunk_num}...", file=sys.stderr)
                continue
            else:
                raise Exception(f"Failed to parse sections from AI response after {MAX_RETRIES} attempts")

        except Exception as e:
            if attempt < MAX_RETRIES:
                print(f"[ERROR] Error on attempt {attempt} for chunk {chunk_num}: {e}", file=sys.stderr)
                print(f"[INFO] Retrying chunk {chunk_num}...", file=sys.stderr)
                continue
            else:
                print(f"[ERROR] Failed to analyze chunk {chunk_num} after {MAX_RETRIES} attempts: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                raise Exception(f"Chunk {chunk_num} failed after {MAX_RETRIES} attempts")

    # Should never reach here
    raise Exception(f"Chunk {chunk_num} failed unexpectedly")


def analyze_section_detail(provider: str, endpoint_or_key: str, model: str, section: Dict, all_segments: List[Dict]) -> Optional[Dict]:
    """
    Perform detailed analysis on a specific section
    Uses two-phase approach: correlate phrases to timestamps, then analyze
    """
    try:
        print(f"\n[DEBUG] Analyzing section: {section['category']} - {section['description']}", file=sys.stderr)

        # Phase 1: Find timestamps for start and end phrases
        start_phrase = section.get('start_phrase', '')
        end_phrase = section.get('end_phrase', '')

        print(f"[DEBUG] Looking for start phrase: '{start_phrase[:50]}...'", file=sys.stderr)
        start_time = find_phrase_timestamp(start_phrase, all_segments)

        print(f"[DEBUG] Looking for end phrase: '{end_phrase[:50]}...'", file=sys.stderr)
        end_time = find_phrase_timestamp(end_phrase, all_segments)

        # If we can't find timestamps, skip this section
        if start_time is None or end_time is None:
            print(f"[DEBUG] Could not correlate timestamps for section, skipping", file=sys.stderr)
            return None

        # Ensure end_time is after start_time
        if end_time <= start_time:
            print(f"[DEBUG] End time ({end_time}) not after start time ({start_time}), adjusting", file=sys.stderr)
            # Add some buffer (30 seconds)
            end_time = start_time + 30

        print(f"[DEBUG] Section spans {start_time}s to {end_time}s", file=sys.stderr)

        # Phase 2: Extract segments in this time range
        section_segments = extract_segment_range(all_segments, start_time, end_time)

        if not section_segments:
            print(f"[DEBUG] No segments found in time range, using broader range", file=sys.stderr)
            # Try with a broader range
            section_segments = extract_segment_range(all_segments, start_time - 5, end_time + 5)

        if not section_segments:
            print(f"[DEBUG] Still no segments found, skipping section", file=sys.stderr)
            return None

        print(f"[DEBUG] Extracted {len(section_segments)} segments for detailed analysis", file=sys.stderr)

        # Phase 3: Build timestamped transcript for this specific section
        timestamped_text = build_timestamped_transcript(section_segments)

        # Phase 4: Ask AI to extract quotes from this timestamped section
        prompt = QUOTE_EXTRACTION_PROMPT.format(
            category=section['category'],
            description=section['description'],
            timestamped_text=timestamped_text[:6000]
        )

        # Use very large timeout (30 minutes) - we don't care about timeout
        response = call_ai(provider, endpoint_or_key, model, prompt, timeout=1800)

        if not response:
            print(f"[DEBUG] No response from AI for detailed analysis", file=sys.stderr)
            return None

        # Parse quotes from response
        quotes = parse_quotes_response(response)

        if quotes:
            print(f"[DEBUG] Successfully extracted {len(quotes)} quotes from section", file=sys.stderr)
            return {
                "category": section['category'],
                "description": section['description'],
                "start_time": format_display_time(start_time),
                "end_time": format_display_time(end_time),
                "quotes": quotes
            }
        else:
            print(f"[DEBUG] No quotes parsed from response", file=sys.stderr)

        return None

    except Exception as e:
        print(f"[ERROR] Error in detailed analysis: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def build_timestamped_transcript(segments: List[Dict]) -> str:
    """Build timestamped transcript for AI analysis"""
    lines = []
    for seg in segments[:200]:  # Limit segments for speed
        timestamp = format_display_time(seg['start'])
        lines.append(f"[{timestamp}] {seg['text'].strip()}")
    return "\n".join(lines)


def format_display_time(seconds: float) -> str:
    """Format time for display (MM:SS or HH:MM:SS)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes}:{secs:02d}"


def find_phrase_timestamp(phrase: str, segments: List[Dict], threshold: float = 0.5) -> Optional[float]:
    """
    Find the timestamp for a specific phrase in the transcript segments
    Uses fuzzy matching to find the best match
    """
    if not phrase or not segments:
        return None

    # Normalize and split phrase into words
    phrase_words = phrase.lower().strip().split()

    if len(phrase_words) == 0:
        return None

    best_score = 0.0
    best_timestamp = None

    # Search through all segments
    for segment in segments:
        segment_text = segment.get('text', '').lower().strip()
        segment_words = segment_text.split()

        # Calculate match score
        if len(segment_words) == 0:
            continue

        # Check if phrase words appear in segment (in order)
        matches = 0
        segment_idx = 0

        for phrase_word in phrase_words:
            # Look for this phrase word in remaining segment words
            while segment_idx < len(segment_words):
                if phrase_word in segment_words[segment_idx] or segment_words[segment_idx] in phrase_word:
                    matches += 1
                    segment_idx += 1
                    break
                segment_idx += 1

        # Calculate score as percentage of phrase words found
        score = matches / len(phrase_words)

        if score > best_score:
            best_score = score
            best_timestamp = segment.get('start', 0.0)

    # Only return if we found a reasonable match
    if best_score >= threshold:
        print(f"[DEBUG] Matched phrase '{phrase[:50]}...' with score {best_score:.2f} at {best_timestamp}s", file=sys.stderr)
        return best_timestamp
    else:
        print(f"[DEBUG] Could not match phrase '{phrase[:50]}...' (best score: {best_score:.2f})", file=sys.stderr)
        return None


def extract_segment_range(segments: List[Dict], start_time: float, end_time: float) -> List[Dict]:
    """
    Extract segments within a specific time range
    """
    return [
        seg for seg in segments
        if seg.get('start', 0) >= start_time and seg.get('end', 0) <= end_time
    ]


def call_ai(provider: str, endpoint_or_key: str, model: str, prompt: str, timeout: int = 60) -> Optional[str]:
    """Call AI provider (Ollama, OpenAI, or Claude) with prompt"""
    if provider == 'openai':
        return call_openai(endpoint_or_key, model, prompt, timeout)
    elif provider == 'claude':
        return call_claude(endpoint_or_key, model, prompt, timeout)
    else:  # default to ollama
        return call_ollama(endpoint_or_key, model, prompt, timeout)


def call_openai(api_key: str, model: str, prompt: str, timeout: int = 60) -> Optional[str]:
    """Call OpenAI API with prompt"""
    if not OPENAI_AVAILABLE:
        print(f"[ERROR] OpenAI package not available. Install with: pip install openai", file=sys.stderr)
        return None

    import time
    start_time = time.time()

    try:
        print(f"[DEBUG] Calling OpenAI with model {model}, timeout={timeout}s", file=sys.stderr)
        print(f"[DEBUG] Prompt length: {len(prompt)} chars", file=sys.stderr)

        client = OpenAI(api_key=api_key, timeout=timeout)

        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": prompt}
            ],
            max_tokens=4096,
            temperature=0.7
        )

        elapsed = time.time() - start_time
        response_text = response.choices[0].message.content or ''

        # Extract token usage
        input_tokens = response.usage.prompt_tokens if response.usage else 0
        output_tokens = response.usage.completion_tokens if response.usage else 0
        total_tokens = input_tokens + output_tokens

        print(f"[DEBUG] OpenAI responded successfully in {elapsed:.1f}s", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response_text)} chars", file=sys.stderr)
        print(f"[TOKEN_USAGE] OpenAI: {input_tokens} input + {output_tokens} output = {total_tokens} total", file=sys.stderr)

        return response_text

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"[ERROR] OpenAI request failed after {elapsed:.1f}s: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def call_claude(api_key: str, model: str, prompt: str, timeout: int = 60) -> Optional[str]:
    """Call Claude (Anthropic) API with prompt"""
    if not ANTHROPIC_AVAILABLE:
        print(f"[ERROR] Anthropic package not available. Install with: pip install anthropic", file=sys.stderr)
        return None

    import time
    start_time = time.time()

    try:
        print(f"[DEBUG] Calling Claude with model {model}, timeout={timeout}s", file=sys.stderr)
        print(f"[DEBUG] Prompt length: {len(prompt)} chars", file=sys.stderr)

        client = Anthropic(api_key=api_key, timeout=timeout)

        response = client.messages.create(
            model=model,
            max_tokens=4096,
            temperature=0.7,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )

        elapsed = time.time() - start_time

        # Extract text from response
        response_text = ''
        for block in response.content:
            if hasattr(block, 'text'):
                response_text += block.text

        # Extract token usage
        input_tokens = response.usage.input_tokens if hasattr(response, 'usage') else 0
        output_tokens = response.usage.output_tokens if hasattr(response, 'usage') else 0
        total_tokens = input_tokens + output_tokens

        print(f"[DEBUG] Claude responded successfully in {elapsed:.1f}s", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response_text)} chars", file=sys.stderr)
        print(f"[TOKEN_USAGE] Claude: {input_tokens} input + {output_tokens} output = {total_tokens} total", file=sys.stderr)

        return response_text

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"[ERROR] Claude request failed after {elapsed:.1f}s: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def call_ollama(endpoint: str, model: str, prompt: str, timeout: int = 60) -> Optional[str]:
    """Call Ollama API with prompt"""
    import time
    start_time = time.time()

    try:
        url = f"{endpoint}/api/generate"
        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": "5m",  # Keep model loaded for 5 minutes after request
            "options": {
                "temperature": 0.7,
                "num_predict": 2000  # Limit response length for speed
            }
        }

        print(f"[DEBUG] Calling Ollama with model {model}, timeout={timeout}s, keep_alive=5m", file=sys.stderr)
        print(f"[DEBUG] Prompt length: {len(prompt)} chars", file=sys.stderr)

        response = requests.post(url, json=payload, timeout=timeout)

        elapsed = time.time() - start_time

        if response.status_code == 200:
            data = response.json()
            response_text = data.get('response', '')
            print(f"[DEBUG] Ollama responded successfully in {elapsed:.1f}s", file=sys.stderr)
            print(f"[DEBUG] Response length: {len(response_text)} chars", file=sys.stderr)
            return response_text
        else:
            print(f"[ERROR] Ollama error: {response.status_code}", file=sys.stderr)
            return None

    except requests.exceptions.Timeout:
        elapsed = time.time() - start_time
        print(f"[ERROR] Ollama request timed out after {elapsed:.1f}s (limit: {timeout}s)", file=sys.stderr)
        print(f"[ERROR] Model {model} is too slow. Try a faster model like qwen2.5:7b or qwen2.5:14b", file=sys.stderr)
        return None
    except Exception as e:
        elapsed = time.time() - start_time
        print(f"[ERROR] Ollama request failed after {elapsed:.1f}s: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def parse_section_response(response: str) -> List[Dict]:
    """Parse AI response to extract interesting sections - supports both JSON and legacy text format"""
    sections = []

    try:
        # DEBUG: Log the raw response
        print(f"\n[DEBUG] Raw AI response for section identification:", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response)} chars", file=sys.stderr)
        print(f"[DEBUG] First 500 chars: {response[:500]}", file=sys.stderr)
        print(f"[DEBUG] Last 500 chars: {response[-500:]}", file=sys.stderr)

        # Try JSON parsing first (new format)
        import json
        import re

        # Try to find JSON in the response (handle cases where AI adds extra text)
        json_match = re.search(r'\{[\s\S]*"sections"[\s\S]*\}', response)
        if json_match:
            json_str = json_match.group(0)
            print(f"[DEBUG] Found JSON structure in response", file=sys.stderr)

            try:
                data = json.loads(json_str)
                if 'sections' in data and isinstance(data['sections'], list):
                    sections = data['sections']
                    print(f"[DEBUG] Successfully parsed {len(sections)} sections from JSON", file=sys.stderr)

                    # Validate each section has required fields
                    valid_sections = []
                    for idx, section in enumerate(sections):
                        if all(k in section for k in ['start_phrase', 'end_phrase', 'category', 'description']):
                            valid_sections.append(section)
                            print(f"[DEBUG] Section {idx+1} valid: {section['category']} - {section['description'][:50]}", file=sys.stderr)
                        else:
                            missing = [k for k in ['start_phrase', 'end_phrase', 'category', 'description'] if k not in section]
                            print(f"[DEBUG] Section {idx+1} missing fields: {missing}", file=sys.stderr)

                    return valid_sections
            except json.JSONDecodeError as e:
                print(f"[WARNING] JSON parsing failed: {e}", file=sys.stderr)
                print(f"[WARNING] Falling back to legacy text parsing", file=sys.stderr)
        else:
            print(f"[DEBUG] No JSON structure found, trying legacy text parsing", file=sys.stderr)

        # Legacy text-based parsing (fallback for old format)
        has_section_header = any(marker in response for marker in [
            "INTERESTING SECTIONS:", "Interesting Sections:", "interesting sections:",
            "SECTIONS:", "Sections:", "sections:"
        ])

        if not has_section_header:
            print(f"[DEBUG] Could not find section header in response", file=sys.stderr)
            # Try to extract anyway if we see Section patterns
            if "Section " not in response and "section " not in response:
                print(f"[WARNING] No 'Section' markers found in AI response. Response may be malformed.", file=sys.stderr)
                return []
            print(f"[DEBUG] Found 'Section' markers, attempting to parse anyway...", file=sys.stderr)

        # Split by "Section N:" (case insensitive) - try both "Section " and "section "
        parts = []
        for pattern in ["Section ", "section "]:
            if pattern in response:
                parts = response.split(pattern)[1:]  # Skip everything before first section
                break

        if not parts:
            print(f"[WARNING] Could not split response by section markers", file=sys.stderr)
            return []

        print(f"[DEBUG] Found {len(parts)} potential sections", file=sys.stderr)

        for idx, part in enumerate(parts):
            # Remove any BORING SECTIONS header if present
            if "BORING SECTIONS:" in part or "Boring Sections:" in part:
                part = part.split("BORING SECTIONS:")[0].split("Boring Sections:")[0]

            lines = part.strip().split('\n')
            section_data = {}

            for line in lines:
                line = line.strip()
                # Case-insensitive field detection
                line_lower = line.lower()
                if line_lower.startswith("start:"):
                    section_data['start_phrase'] = line.split(":", 1)[1].strip(' "')
                elif line_lower.startswith("end:"):
                    section_data['end_phrase'] = line.split(":", 1)[1].strip(' "')
                elif line_lower.startswith("category:"):
                    section_data['category'] = line.split(":", 1)[1].strip()
                elif line_lower.startswith("description:"):
                    section_data['description'] = line.split(":", 1)[1].strip()

            if all(k in section_data for k in ['start_phrase', 'end_phrase', 'category', 'description']):
                sections.append(section_data)
                print(f"[DEBUG] Section {idx+1} parsed: {section_data['category']} - {section_data['description'][:50]}", file=sys.stderr)
            else:
                print(f"[DEBUG] Section {idx+1} incomplete (missing fields): {section_data}", file=sys.stderr)
                # Log which fields are missing for debugging
                missing = [k for k in ['start_phrase', 'end_phrase', 'category', 'description'] if k not in section_data]
                print(f"[DEBUG] Missing fields: {missing}", file=sys.stderr)

        print(f"[DEBUG] Successfully parsed {len(sections)} sections from legacy format", file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Error parsing sections: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)

    return sections


def parse_quotes_response(response: str) -> List[Dict]:
    """Parse AI response to extract quotes - supports both JSON and legacy text format"""
    quotes = []

    try:
        # DEBUG: Log the raw response
        print(f"\n[DEBUG] Raw AI response for quote extraction:", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response)} chars", file=sys.stderr)
        print(f"[DEBUG] First 800 chars: {response[:800]}", file=sys.stderr)

        # Try JSON parsing first (new format)
        import json
        import re

        # Try to find JSON in the response
        json_match = re.search(r'\{[\s\S]*"quotes"[\s\S]*\}', response)
        if json_match:
            json_str = json_match.group(0)
            print(f"[DEBUG] Found JSON structure in response", file=sys.stderr)

            try:
                data = json.loads(json_str)
                if 'quotes' in data and isinstance(data['quotes'], list):
                    quotes = data['quotes']
                    print(f"[DEBUG] Successfully parsed {len(quotes)} quotes from JSON", file=sys.stderr)

                    # Validate each quote has required fields
                    valid_quotes = []
                    for idx, quote in enumerate(quotes):
                        if all(k in quote for k in ['timestamp', 'text', 'significance']):
                            valid_quotes.append(quote)
                            print(f"[DEBUG] Quote {idx+1} valid: {quote['timestamp']}", file=sys.stderr)
                        else:
                            missing = [k for k in ['timestamp', 'text', 'significance'] if k not in quote]
                            print(f"[DEBUG] Quote {idx+1} missing fields: {missing}", file=sys.stderr)

                    return valid_quotes
            except json.JSONDecodeError as e:
                print(f"[WARNING] JSON parsing failed: {e}", file=sys.stderr)
                print(f"[WARNING] Falling back to legacy text parsing", file=sys.stderr)
        else:
            print(f"[DEBUG] No JSON structure found, trying legacy text parsing", file=sys.stderr)

        # Legacy text-based parsing (fallback)
        if "Key quotes:" not in response and "Key Quotes:" not in response and "QUOTES:" not in response:
            print(f"[DEBUG] Could not find quotes marker in response", file=sys.stderr)
            # Try alternative formats
            if "Quote:" in response or "Timestamp:" in response:
                print(f"[DEBUG] Found 'Quote:' or 'Timestamp:' markers, attempting to parse anyway...", file=sys.stderr)
                parts = response  # Parse the whole response
            else:
                print(f"[DEBUG] No recognizable quote format found", file=sys.stderr)
                return []
        else:
            # Split by marker
            for marker in ["Key quotes:", "Key Quotes:", "QUOTES:"]:
                if marker in response:
                    parts = response.split(marker)[1].strip()
                    print(f"[DEBUG] Found marker '{marker}'", file=sys.stderr)
                    break

        # Simple parsing - look for Timestamp/Quote/Significance patterns
        current_quote = {}
        quote_count = 0

        for line in parts.split('\n'):
            line = line.strip()

            # Remove leading numbers and periods (e.g., "1. Timestamp:" -> "Timestamp:")
            if line and line[0].isdigit():
                # Find the first letter after numbers/dots/spaces
                i = 0
                while i < len(line) and (line[i].isdigit() or line[i] in '. \t'):
                    i += 1
                if i < len(line):
                    line = line[i:]

            if "Timestamp:" in line or "timestamp:" in line:
                if current_quote and 'timestamp' in current_quote:
                    quotes.append(current_quote)
                    quote_count += 1
                current_quote = {}
                # Extract timestamp - handle various formats
                timestamp = line.split(":", 1)[1].strip() if ":" in line else ""
                timestamp = timestamp.strip('[]() \t')
                current_quote['timestamp'] = timestamp
                print(f"[DEBUG] Found timestamp: {timestamp}", file=sys.stderr)
            elif "Quote:" in line or "quote:" in line:
                # Extract quote text after "Quote:"
                quote_text = line.split("Quote:", 1)[1].strip() if "Quote:" in line else line.split("quote:", 1)[1].strip()
                quote_text = quote_text.strip('"\'')
                current_quote['text'] = quote_text
                print(f"[DEBUG] Found quote: {quote_text[:50]}...", file=sys.stderr)
            elif "Significance:" in line or "significance:" in line:
                # Extract significance after "Significance:"
                significance = line.split("Significance:", 1)[1].strip() if "Significance:" in line else line.split("significance:", 1)[1].strip()
                current_quote['significance'] = significance
                print(f"[DEBUG] Found significance: {significance[:50]}...", file=sys.stderr)

        # Add last quote
        if current_quote and 'timestamp' in current_quote:
            quotes.append(current_quote)
            quote_count += 1

        print(f"[DEBUG] Successfully parsed {len(quotes)} quotes", file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Error parsing quotes: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)

    return quotes


def write_section_to_file(output_file: str, section: Dict, is_first: bool = False):
    """Write a section to the output file (streaming mode)"""
    try:
        mode = 'w' if is_first else 'a'

        with open(output_file, mode, encoding='utf-8') as f:
            if is_first:
                # Write header on first section
                f.write("=" * 80 + "\n")
                f.write("VIDEO ANALYSIS RESULTS\n")
                f.write("=" * 80 + "\n\n")

            # Write section header
            if section.get('category') == 'routine':
                # Routine sections are simpler - just timestamp and description
                f.write(f"**{section['start_time']} - {section['description']} [routine]**\n\n")
            else:
                # Interesting sections get full treatment
                end_time = section.get('end_time', '')
                if end_time:
                    f.write(f"**{section['start_time']} - {end_time} - {section['description']} [{section['category']}]**\n\n")
                else:
                    f.write(f"**{section['start_time']} - {section['description']} [{section['category']}]**\n\n")

                # Write quotes if available
                for quote in section.get('quotes', []):
                    f.write(f"{quote['timestamp']} - \"{quote['text']}\"\n")
                    if quote.get('significance'):
                        f.write(f"   → {quote['significance']}\n")
                    f.write("\n")

            f.write("-" * 80 + "\n\n")
            f.flush()

    except Exception as e:
        print(f"Error writing to file: {e}", file=sys.stderr)


def main():
    """Main entry point for video analysis service"""
    try:
        # Read command from stdin with UTF-8 encoding
        # On Windows, stdin defaults to cp1252 which mangles Unicode characters
        if sys.platform == 'win32':
            import io
            sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

        command_data = json.loads(sys.stdin.read())

        command = command_data.get('command')

        if command == 'transcribe':
            audio_path = command_data['audio_path']
            model = command_data.get('model', 'base')
            language = command_data.get('language', 'en')

            result = transcribe_audio(audio_path, model, language)
            send_result(result)

        elif command == 'analyze':
            provider = command_data.get('ai_provider', 'ollama')  # default to ollama for backwards compatibility
            model = command_data['ai_model']
            transcript_text = command_data['transcript_text']
            segments = command_data['segments']
            output_file = command_data['output_file']
            custom_instructions = command_data.get('custom_instructions', '')
            video_title = command_data.get('video_title', '')
            categories = command_data.get('categories', None)

            # Determine endpoint_or_key based on provider
            if provider in ['openai', 'claude']:
                # For cloud providers, use API key
                endpoint_or_key = command_data.get('api_key', '')
                if not endpoint_or_key:
                    raise Exception(f"API key required for {provider} but not provided")
            else:
                # For Ollama, use endpoint
                endpoint_or_key = command_data.get('ollama_endpoint', 'http://localhost:11434')

            # Debug logging to verify provider and model are correct
            print(f"[DEBUG] Analysis starting with provider='{provider}', model='{model}'", file=sys.stderr)
            print(f"[DEBUG] Video title: '{video_title}'", file=sys.stderr)
            print(f"[DEBUG] Endpoint/Key type: {'API Key' if provider in ['openai', 'claude'] else 'Ollama Endpoint'}", file=sys.stderr)
            print(f"[DEBUG] Endpoint/Key value: {endpoint_or_key if provider == 'ollama' else '***' if endpoint_or_key else 'NOT PROVIDED'}", file=sys.stderr)

            # Debug: Show segment structure
            print(f"[DEBUG] Received {len(segments)} segments", file=sys.stderr)
            if segments and len(segments) > 0:
                print(f"[DEBUG] First segment: {segments[0]}", file=sys.stderr)
                print(f"[DEBUG] Last segment: {segments[-1]}", file=sys.stderr)

            result = analyze_with_ai(provider, endpoint_or_key, model, transcript_text, segments, output_file, custom_instructions, video_title, categories)
            send_result(result)

        elif command == 'check_model':
            endpoint = command_data['ollama_endpoint']
            model = command_data['ai_model']

            available = check_ollama_model(endpoint, model)
            send_result({"available": available})

        elif command == 'check_dependencies':
            # Check if required Python packages are installed
            whisper_available = False
            requests_available = False

            try:
                import whisper
                whisper_available = True
            except ImportError:
                pass

            try:
                import requests
                requests_available = True
            except ImportError:
                pass

            send_result({
                "whisper": whisper_available,
                "requests": requests_available
            })

        else:
            send_error(f"Unknown command: {command}")
            sys.exit(1)

    except Exception as e:
        send_error(f"Service error: {str(e)}")
        sys.exit(1)


if __name__ == '__main__':
    main()
