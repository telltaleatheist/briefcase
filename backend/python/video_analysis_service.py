#!/usr/bin/env python3
"""
Video Analysis Service for Clippy
Handles transcription and AI analysis using Whisper and Ollama
"""

import sys
import json
import os
import time
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional
import requests


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
    """
    try:
        import whisper

        send_progress("transcription", 30, f"Loading Whisper model ({model})...")

        # Load model with speed optimizations
        whisper_model = whisper.load_model(
            model,
            device="cpu",  # Force CPU for compatibility
            in_memory=True
        )

        send_progress("transcription", 40, "Transcribing audio (this may take a few minutes)...")

        # Transcribe with fastest settings
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

        send_progress("transcription", 60, "Transcription complete, formatting results...")

        # Generate SRT content
        srt_content = generate_srt(result['segments'])

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
            data = response.json()
            models = data.get('models', [])
            model_names = [m['name'] for m in models]
            print(f"[Model Check] Available models in Ollama: {', '.join(model_names)}", file=sys.stderr)

            # Check if model name exists in list
            model_exists = model in model_names or f"{model}:latest" in model_names
            if not model_exists:
                print(f"[Model Check] ✗ Model '{model}' not found in Ollama model list", file=sys.stderr)
                print(f"[Model Check] Please run: ollama pull {model}", file=sys.stderr)
                send_error(f"Model '{model}' not found in Ollama. Please run: ollama pull {model}")
                return False

            print(f"[Model Check] ✓ Model '{model}' found in Ollama model list", file=sys.stderr)

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
                "options": {"num_predict": 5}
            },
            timeout=300  # 300 seconds (5 minutes) to allow large model loading
        )

        elapsed_time = time.time() - start_time

        if test_response.status_code == 200:
            print(f"[Model Check] ✓ Model '{model}' is available and responding (took {elapsed_time:.1f}s)", file=sys.stderr)
            response_preview = str(test_response.json())[:100]
            print(f"[Model Check] Response: {response_preview}...", file=sys.stderr)
            return True
        else:
            print(f"[Model Check] ✗ Model '{model}' returned unexpected status {test_response.status_code}", file=sys.stderr)
            try:
                error_data = test_response.json()
                print(f"[Model Check] Error response: {error_data}", file=sys.stderr)
                send_error(f"Model '{model}' failed: {error_data}")
            except:
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


def analyze_with_ollama(
    endpoint: str,
    model: str,
    transcript_text: str,
    segments: List[Dict],
    output_file: str
) -> Dict[str, Any]:
    """
    Analyze transcript using Ollama AI model
    Chunks the transcript and streams analysis results
    """
    try:
        send_progress("analysis", 65, f"Starting AI analysis with {model}...")

        # Check model availability
        if not check_ollama_model(endpoint, model):
            raise Exception(f"Model '{model}' not found in Ollama. Please install it first.")

        # Chunk transcript into time-based segments (15 min chunks)
        chunks = chunk_transcript(segments, chunk_minutes=15)

        send_progress("analysis", 70, f"Analyzing {len(chunks)} chunks...")

        analyzed_sections = []

        for i, chunk in enumerate(chunks, 1):
            chunk_progress = 70 + (i / len(chunks)) * 20  # 70-90%
            send_progress("analysis", chunk_progress, f"Analyzing chunk {i}/{len(chunks)}...")

            # Identify interesting sections
            interesting_sections = identify_interesting_sections(
                endpoint, model, chunk['text'], i
            )

            if interesting_sections:
                send_progress("analysis", chunk_progress + 0.5, f"Found {len(interesting_sections)} sections in chunk {i}")

                # Process each interesting section
                for section in interesting_sections:
                    detailed_analysis = analyze_section_detail(
                        endpoint, model, section, chunk['segments']
                    )
                    if detailed_analysis:
                        analyzed_sections.append(detailed_analysis)
                        # Write section immediately to file (streaming)
                        write_section_to_file(output_file, detailed_analysis, is_first=(i == 1 and len(analyzed_sections) == 1))

        send_progress("analysis", 90, f"Analysis complete. Found {len(analyzed_sections)} interesting sections.")

        return {
            "sections_count": len(analyzed_sections),
            "sections": analyzed_sections
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


def identify_interesting_sections(endpoint: str, model: str, chunk_text: str, chunk_num: int) -> List[Dict]:
    """Use AI to identify interesting sections in a chunk"""
    try:
        prompt = f"""TASK: Analyze this transcript to identify the most interesting sections worth saving.

WHAT TO LOOK FOR:
- Controversial statements or claims
- Strong opinions or debates
- Important factual claims
- Emotional or dramatic moments
- Key arguments or reasoning
- Insightful observations
- Technical explanations
- Surprising information

MANDATORY OUTPUT FORMAT:

You MUST respond in this EXACT format. Do not deviate:

INTERESTING SECTIONS:

Section 1:
Start: "exact first 5-10 words from transcript"
End: "exact last 5-10 words from transcript"
Category: controversy
Description: One sentence explaining why this is interesting

Section 2:
Start: "exact first 5-10 words from transcript"
End: "exact last 5-10 words from transcript"
Category: claim
Description: One sentence explaining why this is interesting

(Continue for all interesting sections found)

IMPORTANT RULES:
- Start and End MUST be exact quotes from the transcript below
- Use double quotes around the phrases
- Categories: controversy, claim, argument, emotional, insight, technical, or other
- Keep descriptions to ONE sentence

TRANSCRIPT TO ANALYZE:
{chunk_text[:8000]}"""  # Limit to ~8k chars for speed

        response = call_ollama(endpoint, model, prompt, timeout=600)  # 10 minutes for large models

        if not response:
            return []

        # Parse the response
        sections = parse_section_response(response)
        return sections

    except Exception as e:
        print(f"[ERROR] Error identifying sections: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return []


def analyze_section_detail(endpoint: str, model: str, section: Dict, all_segments: List[Dict]) -> Optional[Dict]:
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
        prompt = f"""Analyze this timestamped transcript section and extract the most significant quotes with their timestamps.

Category: {section['category']}
Description: {section['description']}

Extract 3-5 key quotes that exemplify this section. For each quote:
1. Include the exact timestamp [MM:SS]
2. Quote the exact words spoken
3. Explain why it's significant (1-2 sentences)

Format your response EXACTLY like this:

Key quotes:

1. Timestamp: [MM:SS]
   Quote: "exact words from transcript"
   Significance: Why this quote matters

2. Timestamp: [MM:SS]
   Quote: "exact words from transcript"
   Significance: Why this quote matters

TIMESTAMPED TRANSCRIPT:
{timestamped_text[:6000]}"""

        response = call_ollama(endpoint, model, prompt, timeout=600)  # 10 minutes for detailed analysis

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
            "options": {
                "temperature": 0.7,
                "num_predict": 2000  # Limit response length for speed
            }
        }

        print(f"[DEBUG] Calling Ollama with model {model}, timeout={timeout}s", file=sys.stderr)
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
    """Parse AI response to extract interesting sections"""
    sections = []

    try:
        # DEBUG: Log the raw response
        print(f"\n[DEBUG] Raw AI response for section identification:", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response)} chars", file=sys.stderr)
        print(f"[DEBUG] First 500 chars: {response[:500]}", file=sys.stderr)
        print(f"[DEBUG] Last 500 chars: {response[-500:]}", file=sys.stderr)

        # Find the INTERESTING SECTIONS block (be more flexible)
        if "INTERESTING SECTIONS:" not in response and "Interesting Sections:" not in response:
            print(f"[DEBUG] Could not find 'INTERESTING SECTIONS:' marker in response", file=sys.stderr)
            # Try to extract anyway if we see Section patterns
            if "Section " not in response:
                print(f"[DEBUG] No 'Section' markers found either. Returning empty.", file=sys.stderr)
                return []
            print(f"[DEBUG] Found 'Section' markers, attempting to parse anyway...", file=sys.stderr)

        # Split by "Section N:" (case insensitive)
        parts = response.split("Section ")[1:]  # Skip everything before first section
        print(f"[DEBUG] Found {len(parts)} potential sections", file=sys.stderr)

        for idx, part in enumerate(parts):
            if "BORING SECTIONS:" in part or "Boring Sections:" in part:
                part = part.split("BORING SECTIONS:")[0].split("Boring Sections:")[0]

            lines = part.strip().split('\n')
            section_data = {}

            for line in lines:
                line = line.strip()
                if line.startswith("Start:"):
                    section_data['start_phrase'] = line.replace("Start:", "").strip(' "')
                elif line.startswith("End:"):
                    section_data['end_phrase'] = line.replace("End:", "").strip(' "')
                elif line.startswith("Category:"):
                    section_data['category'] = line.replace("Category:", "").strip()
                elif line.startswith("Description:"):
                    section_data['description'] = line.replace("Description:", "").strip()

            if all(k in section_data for k in ['start_phrase', 'end_phrase', 'category', 'description']):
                sections.append(section_data)
                print(f"[DEBUG] Section {idx+1} parsed: {section_data['category']} - {section_data['description'][:50]}", file=sys.stderr)
            else:
                print(f"[DEBUG] Section {idx+1} incomplete: {section_data}", file=sys.stderr)

        print(f"[DEBUG] Successfully parsed {len(sections)} sections", file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Error parsing sections: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)

    return sections


def parse_quotes_response(response: str) -> List[Dict]:
    """Parse AI response to extract quotes"""
    quotes = []

    try:
        # DEBUG: Log the raw response
        print(f"\n[DEBUG] Raw AI response for quote extraction:", file=sys.stderr)
        print(f"[DEBUG] Response length: {len(response)} chars", file=sys.stderr)
        print(f"[DEBUG] First 800 chars: {response[:800]}", file=sys.stderr)

        # More flexible marker detection
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

            # Write section
            f.write(f"**{section['start_time']} - {section['end_time']} - {section['description']} [{section['category']}]**\n\n")

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
        # Read command from stdin
        command_data = json.loads(sys.stdin.read())

        command = command_data.get('command')

        if command == 'transcribe':
            audio_path = command_data['audio_path']
            model = command_data.get('model', 'base')
            language = command_data.get('language', 'en')

            result = transcribe_audio(audio_path, model, language)
            send_result(result)

        elif command == 'analyze':
            endpoint = command_data['ollama_endpoint']
            model = command_data['ai_model']
            transcript_text = command_data['transcript_text']
            segments = command_data['segments']
            output_file = command_data['output_file']

            result = analyze_with_ollama(endpoint, model, transcript_text, segments, output_file)
            send_result(result)

        elif command == 'check_model':
            endpoint = command_data['ollama_endpoint']
            model = command_data['ai_model']

            available = check_ollama_model(endpoint, model)
            send_result({"available": available})

        else:
            send_error(f"Unknown command: {command}")
            sys.exit(1)

    except Exception as e:
        send_error(f"Service error: {str(e)}")
        sys.exit(1)


if __name__ == '__main__':
    main()
