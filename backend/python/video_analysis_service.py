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
        prompt = f"""Analyze this transcript and identify the most interesting sections. Look for:
- Controversial statements or claims
- Strong opinions or debates
- Important factual claims
- Emotional or dramatic moments
- Key arguments or reasoning

For each interesting section, provide:
1. Start phrase (first 5-10 words)
2. End phrase (last 5-10 words)
3. Category (controversy, claim, argument, emotional, or other)
4. Brief description (one sentence)

Format your response EXACTLY like this:

INTERESTING SECTIONS:
Section 1:
Start: "exact first few words"
End: "exact last few words"
Category: controversy
Description: Brief one-line description

Section 2:
Start: "exact first few words"
End: "exact last few words"
Category: claim
Description: Brief one-line description

BORING SECTIONS:
(List any boring parts to skip)

TRANSCRIPT:
{chunk_text[:8000]}"""  # Limit to ~8k chars for speed

        response = call_ollama(endpoint, model, prompt, timeout=120)

        if not response:
            return []

        # Parse the response
        sections = parse_section_response(response)
        return sections

    except Exception as e:
        print(f"Error identifying sections: {e}", file=sys.stderr)
        return []


def analyze_section_detail(endpoint: str, model: str, section: Dict, segments: List[Dict]) -> Optional[Dict]:
    """Perform detailed analysis on a specific section"""
    try:
        # Build timestamped transcript for this section
        timestamped_text = build_timestamped_transcript(segments)

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

        response = call_ollama(endpoint, model, prompt, timeout=90)

        if not response:
            return None

        # Parse quotes from response
        quotes = parse_quotes_response(response)

        if quotes:
            return {
                "category": section['category'],
                "description": section['description'],
                "start_time": format_display_time(segments[0]['start']),
                "end_time": format_display_time(segments[-1]['end']),
                "quotes": quotes
            }

        return None

    except Exception as e:
        print(f"Error in detailed analysis: {e}", file=sys.stderr)
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


def call_ollama(endpoint: str, model: str, prompt: str, timeout: int = 60) -> Optional[str]:
    """Call Ollama API with prompt"""
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

        response = requests.post(url, json=payload, timeout=timeout)

        if response.status_code == 200:
            data = response.json()
            return data.get('response', '')
        else:
            print(f"Ollama error: {response.status_code}", file=sys.stderr)
            return None

    except Exception as e:
        print(f"Ollama request failed: {e}", file=sys.stderr)
        return None


def parse_section_response(response: str) -> List[Dict]:
    """Parse AI response to extract interesting sections"""
    sections = []

    try:
        # Find the INTERESTING SECTIONS block
        if "INTERESTING SECTIONS:" not in response:
            return []

        # Split by "Section N:"
        parts = response.split("Section ")[1:]  # Skip everything before first section

        for part in parts:
            if "BORING SECTIONS:" in part:
                part = part.split("BORING SECTIONS:")[0]

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

    except Exception as e:
        print(f"Error parsing sections: {e}", file=sys.stderr)

    return sections


def parse_quotes_response(response: str) -> List[Dict]:
    """Parse AI response to extract quotes"""
    quotes = []

    try:
        if "Key quotes:" not in response:
            return []

        # Split by numbered items
        parts = response.split("Key quotes:")[1].strip()

        # Simple parsing - look for Timestamp/Quote/Significance patterns
        current_quote = {}

        for line in parts.split('\n'):
            line = line.strip()

            if line.startswith("Timestamp:"):
                if current_quote and 'timestamp' in current_quote:
                    quotes.append(current_quote)
                current_quote = {}
                timestamp = line.replace("Timestamp:", "").strip().strip('[]')
                current_quote['timestamp'] = timestamp
            elif line.startswith("Quote:"):
                quote_text = line.replace("Quote:", "").strip().strip('"')
                current_quote['text'] = quote_text
            elif line.startswith("Significance:"):
                significance = line.replace("Significance:", "").strip()
                current_quote['significance'] = significance

        # Add last quote
        if current_quote and 'timestamp' in current_quote:
            quotes.append(current_quote)

    except Exception as e:
        print(f"Error parsing quotes: {e}", file=sys.stderr)

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
