/**
 * AI Analysis Service - Two-Pass Chapter-Centric Analysis
 *
 * This service implements a two-pass approach to video analysis:
 *   Pass 1: Detect chapter boundaries (chunked, lightweight)
 *   Pass 2: Analyze each chapter with full context (title, summary, category flags)
 *
 * Metadata (description, tags, title) is generated from chapter summaries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { OllamaService } from './ollama.service';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildBoundaryDetectionPrompt,
  buildChapterAnalysisPrompt,
  interpolatePrompt,
  DESCRIPTION_FROM_CHAPTERS_PROMPT,
  TAGS_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_CHAPTERS_PROMPT,
  DEFAULT_PROMPTS,
  AnalysisCategory,
} from './prompts/analysis-prompts';

// Interface for custom prompts loaded from config
interface CustomPrompts {
  description?: string;
  title?: string;
  tags?: string;
  quotes?: string;
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface Segment {
  start: number;
  end: number;
  text: string;
}

interface Chunk {
  number: number;
  startTime: number;
  endTime: number;
  text: string;
  segments: Segment[];
}

export interface Quote {
  timestamp: string;
  text: string;
  significance?: string;
}

export interface AnalyzedSection {
  category: string;
  description: string;
  start_time: string;
  end_time: string | null;
  quotes: Quote[];
}

export interface Chapter {
  sequence: number;
  start_time: string;
  end_time: string;
  title: string;
  summary?: string;
}

// Interface for category flags detected within chapters
export interface ChapterFlag {
  category: string;
  description: string;
  quote: string;
}

// Interface for boundary detection response
interface BoundaryDetectionResult {
  boundaries: string[];
  end_topic: string;
}

// Interface for chapter analysis response
interface ChapterAnalysisResult {
  title: string;
  summary: string;
  flags?: ChapterFlag[];
}

export interface Tags {
  people: string[];
  topics: string[];
}

export interface AnalysisProgress {
  phase: string;
  progress: number;
  message: string;
}

export interface AnalysisOptions {
  provider: 'ollama' | 'openai' | 'claude';
  model: string;
  transcript: string;
  segments: Segment[];
  outputFile: string;
  customInstructions?: string;
  videoTitle?: string;
  categories?: AnalysisCategory[];
  apiKey?: string;
  ollamaEndpoint?: string;
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  apiCalls: number;
}

export interface AnalysisResult {
  sections_count: number;
  sections: AnalyzedSection[];
  chapters: Chapter[];
  tags?: Tags;
  description?: string;
  suggested_title?: string;
  tokenStats?: TokenStats;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;

// Model size limits - conservative estimates based on typical context windows
// These ensure chunks fit comfortably with room for prompts and output
interface ModelLimits {
  maxChunkChars: number;    // Max chars per chunk for boundary detection
  maxChapterChars: number;  // Max chars per chapter for analysis
  chunkMinutes: number;     // Target chunk duration
}

function getModelLimits(modelName: string): ModelLimits {
  // Extract parameter count from model name (e.g., "qwen2.5:7b" -> 7)
  const match = modelName.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b/);
  const paramBillions = match ? parseFloat(match[1]) : 7; // Default to 7b if unknown

  // Small models (≤3b): Very conservative - may have 4K-8K context
  if (paramBillions <= 3) {
    return {
      maxChunkChars: 12000,   // ~3K tokens
      maxChapterChars: 16000, // ~4K tokens
      chunkMinutes: 5,
    };
  }

  // Medium models (≤7b): Conservative - typically 8K-32K context
  if (paramBillions <= 7) {
    return {
      maxChunkChars: 24000,   // ~6K tokens
      maxChapterChars: 32000, // ~8K tokens
      chunkMinutes: 10,
    };
  }

  // Large models (≤14b): Moderate - typically 32K+ context
  if (paramBillions <= 14) {
    return {
      maxChunkChars: 40000,   // ~10K tokens
      maxChapterChars: 48000, // ~12K tokens
      chunkMinutes: 15,
    };
  }

  // Very large models (>14b): Full capacity - typically 32K-128K context
  return {
    maxChunkChars: 60000,   // ~15K tokens
    maxChapterChars: 80000, // ~20K tokens
    chunkMinutes: 20,
  };
}

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);

  // Custom prompts cache
  private customPromptsCache: CustomPrompts | null = null;
  private customPromptsCacheTime: number = 0;
  private readonly CACHE_TTL = 30000; // 30 seconds

  constructor(
    private readonly aiProviderService: AIProviderService,
    private readonly ollamaService: OllamaService,
  ) {}

  /**
   * Load custom prompts from config file
   */
  private loadCustomPrompts(): CustomPrompts {
    const now = Date.now();
    if (
      this.customPromptsCache &&
      now - this.customPromptsCacheTime < this.CACHE_TTL
    ) {
      return this.customPromptsCache;
    }

    let prompts: CustomPrompts = {};
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const configPath = path.join(
        homeDir,
        'Library',
        'Application Support',
        'clippy',
        'prompts.json',
      );

      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        prompts = parsed.prompts || {};
      }
    } catch (error) {
      this.logger.warn('Failed to load custom prompts, using defaults:', error);
    }

    this.customPromptsCache = prompts;
    this.customPromptsCacheTime = now;
    return prompts;
  }

  /**
   * Get the effective prompt (custom or default)
   */
  private getPrompt(promptKey: keyof CustomPrompts): string {
    const customPrompts = this.loadCustomPrompts();
    if (customPrompts[promptKey]) {
      return customPrompts[promptKey]!;
    }
    return DEFAULT_PROMPTS[promptKey];
  }

  /**
   * Main entry point: Analyze transcript using AI
   * Uses two-pass chapter-centric analysis:
   *   Pass 1: Detect chapter boundaries (chunked, lightweight)
   *   Pass 2: Analyze each chapter with full context (title, summary, flags)
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    console.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    console.log(`Provider: ${options.provider}, Model: ${options.model}`);
    console.log(`[analyzeTranscript] SEGMENTS RECEIVED: ${options.segments?.length || 0}`);
    if (options.segments && options.segments.length > 0) {
      console.log(`[analyzeTranscript] First segment: start=${options.segments[0].start}, end=${options.segments[0].end}, text="${options.segments[0].text?.substring(0, 50)}"`);
      console.log(`[analyzeTranscript] Last segment: start=${options.segments[options.segments.length - 1].start}, end=${options.segments[options.segments.length - 1].end}`);
    } else {
      console.log(`[analyzeTranscript] WARNING: No segments or empty segments array!`);
    }
    this.logger.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    this.logger.log(`Provider: ${options.provider}, Model: ${options.model}`);

    const {
      provider,
      model,
      segments,
      outputFile,
      videoTitle = '',
      categories,
      customInstructions,
      apiKey,
      ollamaEndpoint,
      onProgress,
    } = options;

    const sendProgress = (phase: string, progress: number, message: string) => {
      console.log(`[AI Analysis] ${progress}% - ${message}`);
      if (onProgress) {
        onProgress({ phase, progress, message });
      }
    };

    // Token tracking for API calls
    const tokenStats: TokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      apiCalls: 0,
    };

    const trackTokens = (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => {
      console.log(`[trackTokens] Received: inputTokens=${response.inputTokens}, outputTokens=${response.outputTokens}, cost=${response.estimatedCost}`);
      if (response.inputTokens) tokenStats.inputTokens += response.inputTokens;
      if (response.outputTokens) tokenStats.outputTokens += response.outputTokens;
      tokenStats.totalTokens = tokenStats.inputTokens + tokenStats.outputTokens;
      if (response.estimatedCost) tokenStats.estimatedCost += response.estimatedCost;
      tokenStats.apiCalls++;
      console.log(`[trackTokens] Running total: apiCalls=${tokenStats.apiCalls}, totalTokens=${tokenStats.totalTokens}`);
    };

    try {
      sendProgress('analysis', 0, `Starting AI analysis with ${model}...`);

      // Check model availability (only for Ollama)
      if (provider === 'ollama') {
        const available = await this.ollamaService.isModelAvailable(
          model,
          ollamaEndpoint,
        );
        if (!available) {
          throw new Error(
            `Model '${model}' not found in Ollama. Please install it first.`,
          );
        }
      }

      // Write header to file
      fs.writeFileSync(
        outputFile,
        '='.repeat(80) +
          '\n' +
          'VIDEO ANALYSIS RESULTS\n' +
          '='.repeat(80) +
          '\n\n',
        'utf-8',
      );

      const aiConfig: AIProviderConfig = {
        provider,
        model,
        apiKey,
        ollamaEndpoint,
      };

      // Get model-specific limits
      const modelLimits = getModelLimits(model);
      this.logger.log(
        `[Model Limits] ${model}: chunkMinutes=${modelLimits.chunkMinutes}, ` +
        `maxChunkChars=${modelLimits.maxChunkChars}, maxChapterChars=${modelLimits.maxChapterChars}`,
      );

      // =========================================================================
      // PASS 1: Detect chapter boundaries
      // =========================================================================
      sendProgress('analysis', 5, 'Detecting chapter boundaries...');
      const boundaries = await this.detectChapterBoundaries(
        aiConfig,
        segments,
        videoTitle,
        modelLimits,
        trackTokens,
      );
      sendProgress('analysis', 25, `Found ${boundaries.length} chapters`);

      // =========================================================================
      // PASS 2: Analyze each chapter (title, summary, category flags)
      // =========================================================================
      sendProgress('analysis', 30, 'Analyzing chapters...');
      const { chapters, flags } = await this.analyzeChaptersPass2(
        aiConfig,
        segments,
        boundaries,
        videoTitle,
        categories || [],
        modelLimits,
        customInstructions,
        trackTokens,
      );
      sendProgress('analysis', 70, `Analyzed ${chapters.length} chapters, found ${flags.length} flags`);

      // Write chapter flags to file
      for (const flag of flags) {
        this.writeSectionToFile(outputFile, flag);
      }

      // =========================================================================
      // Generate metadata FROM chapters
      // =========================================================================
      sendProgress('analysis', 75, 'Generating description...');
      const description = await this.generateDescriptionFromChapters(
        aiConfig,
        chapters,
        videoTitle,
        trackTokens,
      );

      sendProgress('analysis', 85, 'Extracting tags...');
      const tags = await this.generateTagsFromChapters(
        aiConfig,
        chapters,
        trackTokens,
      );

      sendProgress('analysis', 92, 'Generating suggested title...');
      const suggestedTitle = await this.generateTitleFromChapters(
        aiConfig,
        chapters,
        videoTitle,
        trackTokens,
      );

      // Prepend summary to file
      this.prependSummaryToFile(outputFile, description);

      // Log token usage summary
      console.log('');
      console.log('='.repeat(60));
      console.log('AI ANALYSIS TOKEN USAGE SUMMARY (Two-Pass)');
      console.log('='.repeat(60));
      console.log(`Provider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(`API Calls: ${tokenStats.apiCalls}`);
      console.log(`Input Tokens: ${tokenStats.inputTokens.toLocaleString()}`);
      console.log(`Output Tokens: ${tokenStats.outputTokens.toLocaleString()}`);
      console.log(`Total Tokens: ${tokenStats.totalTokens.toLocaleString()}`);
      console.log('='.repeat(60));
      console.log('');

      this.logger.log('AI ANALYSIS TOKEN SUMMARY: ' +
        `apiCalls=${tokenStats.apiCalls}, ` +
        `inputTokens=${tokenStats.inputTokens}, ` +
        `outputTokens=${tokenStats.outputTokens}, ` +
        `totalTokens=${tokenStats.totalTokens}`
      );

      sendProgress('analysis', 100, 'Analysis complete!');

      // Debug: Log what we're returning
      console.log(`[analyzeTranscript] RETURNING: sections=${flags.length}, chapters=${chapters.length}, tags=${JSON.stringify(tags)}`);
      if (chapters.length > 0) {
        console.log(`[analyzeTranscript] Chapters being returned: ${JSON.stringify(chapters)}`);
      }

      return {
        sections_count: flags.length,
        sections: flags,           // Category flags from chapter analysis
        chapters: chapters,        // Chapter list with titles/summaries
        tags,
        description,
        suggested_title: suggestedTitle || undefined,
        tokenStats: tokenStats.apiCalls > 0 ? tokenStats : undefined,
      };
    } catch (error) {
      const message = `AI analysis failed: ${(error as Error).message}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  /**
   * Split transcript into time-based chunks
   */
  private chunkTranscript(
    segments: Segment[],
    chunkMinutes: number = 15,
  ): Chunk[] {
    console.log(`[chunkTranscript] Input segments: ${segments?.length || 0}, chunkMinutes: ${chunkMinutes}`);
    const chunks: Chunk[] = [];

    if (!segments || segments.length === 0) {
      console.log(`[chunkTranscript] WARNING: No segments to chunk!`);
      return [];
    }

    const chunkDuration = chunkMinutes * 60;
    const totalDuration = segments[segments.length - 1].end;
    console.log(`[chunkTranscript] Total duration: ${totalDuration}s, chunk duration: ${chunkDuration}s`);

    let currentStart = 0;
    let chunkNum = 1;

    while (currentStart < totalDuration) {
      const chunkEnd = currentStart + chunkDuration;

      const chunkSegments = segments.filter(
        (seg) => seg.start >= currentStart && seg.start < chunkEnd,
      );

      if (chunkSegments.length > 0) {
        const chunkText = chunkSegments.map((seg) => seg.text.trim()).join(' ');
        chunks.push({
          number: chunkNum,
          startTime: currentStart,
          endTime: Math.min(chunkEnd, totalDuration),
          text: chunkText,
          segments: chunkSegments,
        });
        console.log(`[chunkTranscript] Chunk ${chunkNum}: ${chunkSegments.length} segments, time ${currentStart}-${Math.min(chunkEnd, totalDuration)}`);
        chunkNum++;
      }

      currentStart = chunkEnd;
    }

    console.log(`[chunkTranscript] Created ${chunks.length} chunks total`);
    return chunks;
  }

  /**
   * Find the timestamp for a specific phrase in the transcript segments
   * Uses the first ~40 chars of the phrase to avoid cross-segment matching issues
   */
  private findPhraseTimestamp(
    phrase: string,
    segments: Segment[],
  ): number | null {
    if (!phrase || !segments || segments.length === 0) {
      return null;
    }

    const normalizedPhrase = phrase.toLowerCase().trim();
    if (normalizedPhrase.length < 3) {
      return null;
    }

    // Use first ~40 chars for matching (long quotes may span multiple segments)
    const searchPhrase = normalizedPhrase.substring(0, 40);

    // Strategy 1: Direct substring match using first part of phrase
    for (const segment of segments) {
      const normalizedText = segment.text.toLowerCase();
      if (normalizedText.includes(searchPhrase)) {
        return segment.start;
      }
    }

    // Strategy 1b: Try even shorter prefix (first 20 chars) if long match failed
    if (searchPhrase.length > 20) {
      const shortSearchPhrase = normalizedPhrase.substring(0, 20);
      for (const segment of segments) {
        const normalizedText = segment.text.toLowerCase();
        if (normalizedText.includes(shortSearchPhrase)) {
          return segment.start;
        }
      }
    }

    // Strategy 2: Word-based fuzzy match
    const phraseWords = normalizedPhrase.split(/\s+/).filter((w) => w.length > 2);
    if (phraseWords.length === 0) {
      return null;
    }

    let bestMatch: { segment: Segment; score: number } | null = null;

    for (const segment of segments) {
      const segmentWords = segment.text.toLowerCase().split(/\s+/);
      let matchedWords = 0;

      for (const phraseWord of phraseWords) {
        if (
          segmentWords.some(
            (sw) => sw.includes(phraseWord) || phraseWord.includes(sw),
          )
        ) {
          matchedWords++;
        }
      }

      const score = matchedWords / phraseWords.length;
      if (score > 0.5 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { segment, score };
      }
    }

    if (bestMatch) {
      return bestMatch.segment.start;
    }

    // Strategy 3: Check across segment boundaries
    for (let i = 0; i < segments.length - 1; i++) {
      const combinedText = (
        segments[i].text +
        ' ' +
        segments[i + 1].text
      ).toLowerCase();
      if (combinedText.includes(normalizedPhrase)) {
        return segments[i].start;
      }
    }

    return null;
  }

  // =============================================================================
  // TWO-PASS CHAPTER ANALYSIS METHODS
  // =============================================================================

  /**
   * PASS 1: Detect chapter boundaries using chunked processing
   * Processes transcript in time-based chunks to find topic change points
   */
  private async detectChapterBoundaries(
    config: AIProviderConfig,
    segments: Segment[],
    videoTitle: string,
    limits: ModelLimits,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<number[]> {
    const boundaries: number[] = [0]; // First chapter always starts at 0
    let previousTopic = '';

    if (!segments || segments.length === 0) {
      this.logger.warn('No segments available for boundary detection');
      return boundaries;
    }

    const chunks = this.chunkTranscript(segments, limits.chunkMinutes);
    this.logger.log(`[Pass 1] Detecting boundaries in ${chunks.length} chunks (${limits.chunkMinutes} min each)`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isFirst = i === 0;

      try {
        const prompt = buildBoundaryDetectionPrompt(
          videoTitle,
          chunk.text.substring(0, limits.maxChunkChars),
          previousTopic,
          isFirst,
        );

        const response = await this.aiProviderService.generateText(prompt, config);
        onTokens?.(response);

        if (!response || !response.text) {
          this.logger.warn(`[Pass 1] No response for chunk ${i + 1}`);
          continue;
        }

        const result = this.parseBoundaryResponse(response.text);

        // Map phrases to timestamps
        for (const phrase of result.boundaries) {
          const time = this.findPhraseTimestamp(phrase, chunk.segments);
          if (time !== null && !boundaries.includes(time)) {
            boundaries.push(time);
            this.logger.debug(`[Pass 1] Found boundary at ${this.formatDisplayTime(time)}: "${phrase.substring(0, 30)}..."`);
          }
        }

        previousTopic = result.end_topic;
        this.logger.debug(`[Pass 1] Chunk ${i + 1} end topic: "${previousTopic}"`);
      } catch (error) {
        this.logger.warn(`[Pass 1] Error processing chunk ${i + 1}: ${(error as Error).message}`);
      }
    }

    // Sort boundaries by time
    boundaries.sort((a, b) => a - b);
    this.logger.log(`[Pass 1] Found ${boundaries.length} chapter boundaries`);

    return boundaries;
  }

  /**
   * Parse boundary detection response
   */
  private parseBoundaryResponse(response: string): BoundaryDetectionResult {
    try {
      // Clean up response and extract JSON
      let cleanResponse = response.trim();

      // Remove markdown code blocks
      if (cleanResponse.startsWith('```')) {
        const lines = cleanResponse.split('\n');
        cleanResponse = lines.filter((l) => !l.startsWith('```')).join('\n');
      }

      // Extract JSON object
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('[Pass 1] No JSON found in boundary response');
        return { boundaries: [], end_topic: '' };
      }

      const data = JSON.parse(jsonMatch[0]);
      return {
        boundaries: Array.isArray(data.boundaries) ? data.boundaries : [],
        end_topic: data.end_topic || '',
      };
    } catch (error) {
      this.logger.warn(`[Pass 1] Failed to parse boundary response: ${(error as Error).message}`);
      return { boundaries: [], end_topic: '' };
    }
  }

  /**
   * PASS 2: Analyze each chapter with full context
   * Generates title, summary, and category flags for each chapter
   */
  private async analyzeChaptersPass2(
    config: AIProviderConfig,
    segments: Segment[],
    boundaries: number[],
    videoTitle: string,
    categories: AnalysisCategory[],
    limits: ModelLimits,
    customInstructions?: string,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<{ chapters: Chapter[]; flags: AnalyzedSection[] }> {
    const chapters: Chapter[] = [];
    const allFlags: AnalyzedSection[] = [];

    if (!segments || segments.length === 0) {
      this.logger.warn('[Pass 2] No segments available for chapter analysis');
      return { chapters, flags: allFlags };
    }

    const videoDuration = segments[segments.length - 1].end;
    let previousChapterSummary = '';

    this.logger.log(`[Pass 2] Analyzing ${boundaries.length} chapters (max ${limits.maxChapterChars} chars each)`);

    for (let i = 0; i < boundaries.length; i++) {
      const startTime = boundaries[i];
      const endTime = i < boundaries.length - 1 ? boundaries[i + 1] : videoDuration;

      // Extract chapter transcript
      const chapterSegments = segments.filter(
        (s) => s.start >= startTime && s.start < endTime,
      );

      if (chapterSegments.length === 0) {
        this.logger.debug(`[Pass 2] No segments for chapter ${i + 1}, skipping`);
        continue;
      }

      const chapterText = chapterSegments.map((s) => s.text).join(' ');

      // Truncate very long chapters based on model limits
      const truncatedText = chapterText.substring(0, limits.maxChapterChars);
      if (chapterText.length > limits.maxChapterChars) {
        this.logger.warn(`[Pass 2] Chapter ${i + 1} truncated from ${chapterText.length} to ${limits.maxChapterChars} chars`);
      }

      try {
        const prompt = buildChapterAnalysisPrompt(
          videoTitle,
          truncatedText,
          categories,
          i + 1,
          previousChapterSummary,
          customInstructions,
        );

        const response = await this.aiProviderService.generateText(prompt, config);
        onTokens?.(response);

        if (!response || !response.text) {
          this.logger.warn(`[Pass 2] No response for chapter ${i + 1}`);
          continue;
        }

        const result = this.parseChapterAnalysisResponse(response.text);

        // Create chapter entry
        chapters.push({
          sequence: i + 1,
          start_time: this.formatDisplayTime(startTime),
          end_time: this.formatDisplayTime(endTime),
          title: result.title,
          summary: result.summary,
        });

        // Save summary for next chapter's context
        previousChapterSummary = result.summary;

        // Convert flags to AnalyzedSection format - pass through without filtering
        if (result.flags && result.flags.length > 0) {
          for (const flag of result.flags) {
            // Try to find the actual timestamp of the quote in the transcript
            let flagStartTime = startTime;
            let foundQuote = false;
            if (flag.quote) {
              const foundTime = this.findPhraseTimestamp(flag.quote, chapterSegments);
              if (foundTime !== null) {
                flagStartTime = foundTime;
                foundQuote = true;
              } else {
                // Quote not found - log for debugging
                this.logger.debug(`[Pass 2] Quote not found in transcript: "${flag.quote.substring(0, 80)}..."`);
              }
            } else {
              this.logger.debug(`[Pass 2] Flag has no quote field: ${JSON.stringify(flag)}`);
            }

            // Build description: prefer quote (verbatim text), fall back to description
            // If both exist, show quote first with reason after
            let displayDescription = flag.description || '';
            if (flag.quote) {
              if (flag.description) {
                displayDescription = `"${flag.quote}" — ${flag.description}`;
              } else {
                displayDescription = `"${flag.quote}"`;
              }
            }

            allFlags.push({
              category: flag.category,
              description: displayDescription,
              start_time: this.formatDisplayTime(flagStartTime),
              end_time: this.formatDisplayTime(Math.min(flagStartTime + 30, endTime)), // ~30 sec duration
              quotes: flag.quote
                ? [
                    {
                      timestamp: this.formatDisplayTime(flagStartTime),
                      text: flag.quote,
                      significance: flag.description,
                    },
                  ]
                : [],
            });
          }
        }

        this.logger.debug(`[Pass 2] Chapter ${i + 1}: "${result.title.substring(0, 50)}..." (${result.flags?.length || 0} flags)`);
      } catch (error) {
        this.logger.warn(`[Pass 2] Error analyzing chapter ${i + 1}: ${(error as Error).message}`);
      }
    }

    // Deduplicate flags with the same or very close timestamps (within 5 seconds)
    // This handles cases where less capable models create multiple flags for the same content
    const deduplicatedFlags: AnalyzedSection[] = [];
    for (const flag of allFlags) {
      // Check if we already have a flag at a similar time
      const existingIndex = deduplicatedFlags.findIndex((f) => {
        const startA = this.parseDisplayTime(f.start_time);
        const startB = this.parseDisplayTime(flag.start_time);
        return Math.abs(startA - startB) < 5; // Within 5 seconds
      });

      if (existingIndex === -1) {
        // No duplicate, add it
        deduplicatedFlags.push(flag);
      } else {
        // Duplicate found - log it but don't add
        this.logger.debug(
          `[Pass 2] Skipping duplicate flag at ${flag.start_time} (category: ${flag.category}) - similar to existing flag at ${deduplicatedFlags[existingIndex].start_time}`,
        );
      }
    }

    if (deduplicatedFlags.length < allFlags.length) {
      this.logger.log(
        `[Pass 2] Deduplicated flags: ${allFlags.length} -> ${deduplicatedFlags.length}`,
      );
    }

    this.logger.log(`[Pass 2] Analyzed ${chapters.length} chapters, found ${deduplicatedFlags.length} category flags`);
    return { chapters, flags: deduplicatedFlags };
  }

  /**
   * Parse chapter analysis response
   */
  private parseChapterAnalysisResponse(response: string): ChapterAnalysisResult {
    try {
      // Clean up response and extract JSON
      let cleanResponse = response.trim();

      // Remove markdown code blocks
      if (cleanResponse.startsWith('```')) {
        const lines = cleanResponse.split('\n');
        cleanResponse = lines.filter((l) => !l.startsWith('```')).join('\n');
      }

      // Extract JSON object
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('[Pass 2] No JSON found in chapter analysis response');
        return { title: 'Unknown', summary: '', flags: [] };
      }

      const data = JSON.parse(jsonMatch[0]);
      const flags = Array.isArray(data.flags) ? data.flags : [];

      // Debug: Log what the AI returned for flags
      if (flags.length > 0) {
        this.logger.debug(`[Pass 2] Raw flags from AI: ${JSON.stringify(flags, null, 2)}`);
      }

      return {
        title: data.title || 'Unknown',
        summary: data.summary || '',
        flags,
      };
    } catch (error) {
      this.logger.warn(`[Pass 2] Failed to parse chapter analysis response: ${(error as Error).message}`);
      return { title: 'Unknown', summary: '', flags: [] };
    }
  }

  /**
   * Generate video description from chapter summaries
   */
  private async generateDescriptionFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    videoTitle: string,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string> {
    try {
      if (!chapters || chapters.length === 0) {
        return 'No content could be analyzed in this video.';
      }

      // Build chapters list
      const chaptersList = chapters
        .map((ch) => `${ch.sequence}. [${ch.start_time}] ${ch.title}${ch.summary ? ` - ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(DESCRIPTION_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response);

      if (response && response.text) {
        const description = response.text.trim();

        // Reject AI refusals
        const invalidPatterns = [
          /^i apologize/i,
          /^i'm sorry/i,
          /^i cannot/i,
          /^unfortunately/i,
          /^as an ai/i,
        ];

        for (const pattern of invalidPatterns) {
          if (pattern.test(description)) {
            this.logger.warn(`Rejected AI refusal in description: "${description.substring(0, 50)}..."`);
            break;
          }
        }

        if (!invalidPatterns.some((p) => p.test(description))) {
          return description;
        }
      }

      // Fallback
      return `Video with ${chapters.length} chapter(s) covering: ${chapters.slice(0, 3).map((c) => c.title).join('; ')}.`;
    } catch (error) {
      this.logger.warn(`Description generation failed: ${(error as Error).message}`);
      return 'Description could not be generated for this video.';
    }
  }

  /**
   * Extract tags from chapter content
   */
  private async generateTagsFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<Tags> {
    try {
      if (!chapters || chapters.length === 0) {
        return { people: [], topics: [] };
      }

      // Build chapters list
      const chaptersList = chapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TAGS_FROM_CHAPTERS_PROMPT, {
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response);

      if (response && response.text) {
        try {
          let cleanResponse = response.text.trim();

          // Remove markdown code blocks
          if (cleanResponse.startsWith('```')) {
            const lines = cleanResponse.split('\n');
            cleanResponse = lines.filter((l) => !l.startsWith('```')).join('\n');
          }

          // Extract JSON object
          const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            this.logger.warn('No JSON object found in tags response');
            return { people: [], topics: [] };
          }

          const tagsData = JSON.parse(jsonMatch[0]);
          return {
            people: Array.isArray(tagsData.people) ? tagsData.people.slice(0, 20) : [],
            topics: Array.isArray(tagsData.topics) ? tagsData.topics.slice(0, 15) : [],
          };
        } catch (parseError) {
          this.logger.warn(`Failed to parse tags JSON: ${(parseError as Error).message}`);
        }
      }

      return { people: [], topics: [] };
    } catch (error) {
      this.logger.warn(`Tags extraction failed: ${(error as Error).message}`);
      return { people: [], topics: [] };
    }
  }

  /**
   * Generate suggested title from chapter content
   */
  private async generateTitleFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    currentTitle: string,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    try {
      if (!chapters || chapters.length === 0) {
        return null;
      }

      // Build chapters list
      const chaptersList = chapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TITLE_FROM_CHAPTERS_PROMPT, {
        currentTitle: currentTitle || 'untitled',
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response);

      if (response && response.text) {
        let suggestedTitle = response.text.trim();

        // Remove quotes
        if (suggestedTitle.startsWith('"') && suggestedTitle.endsWith('"')) {
          suggestedTitle = suggestedTitle.slice(1, -1);
        }

        // Remove file extension
        if (suggestedTitle.includes('.')) {
          suggestedTitle = suggestedTitle.split('.')[0];
        }

        // Remove date prefix
        suggestedTitle = suggestedTitle.replace(/^\d{4}-\d{2}-\d{2}[-\s]*/, '');

        // Lowercase and clean
        suggestedTitle = suggestedTitle.toLowerCase().trim();

        // Remove invalid filesystem characters
        suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');

        // Remove periods
        suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
        suggestedTitle = suggestedTitle.replace(/\.$/, '');

        // Clean up multiple spaces
        suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

        // Reject AI meta-commentary
        const invalidPatterns = [
          /^based on/i,
          /^the transcript/i,
          /^this video/i,
          /^i would/i,
          /^i suggest/i,
          /^here is/i,
          /^the suggested/i,
        ];

        for (const pattern of invalidPatterns) {
          if (pattern.test(suggestedTitle)) {
            this.logger.warn(`Rejected invalid AI title: "${suggestedTitle}"`);
            return null;
          }
        }

        // Length limit
        if (suggestedTitle.length > 200) {
          suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
        }

        // Reject if too short
        if (suggestedTitle.length < 10) {
          this.logger.warn(`Rejected too-short AI title: "${suggestedTitle}"`);
          return null;
        }

        return suggestedTitle || null;
      }

      return null;
    } catch (error) {
      this.logger.warn(`Title generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Write a section to the output file
   */
  private writeSectionToFile(
    outputFile: string,
    section: AnalyzedSection,
  ): void {
    try {
      let content = '';

      const endTime = section.end_time ? section.end_time : '';
      if (endTime) {
        content = `**${section.start_time} - ${endTime} - ${section.description} [${section.category}]**\n\n`;
      } else {
        content = `**${section.start_time} - ${section.description} [${section.category}]**\n\n`;
      }

      for (const quote of section.quotes || []) {
        content += `${quote.timestamp} - "${quote.text}"\n`;
        if (quote.significance) {
          content += `   → ${quote.significance}\n`;
        }
        content += '\n';
      }

      content += '-'.repeat(80) + '\n\n';
      fs.appendFileSync(outputFile, content, 'utf-8');
    } catch (error) {
      this.logger.error(
        `Error writing to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Prepend the video overview section to the analysis file
   */
  private prependSummaryToFile(outputFile: string, summary: string): void {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');

      const headerEnd = existingContent.indexOf('\n\n');
      if (headerEnd !== -1) {
        const header = existingContent.substring(0, headerEnd + 2);
        const rest = existingContent.substring(headerEnd + 2);

        const newContent =
          header +
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          rest;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      } else {
        const newContent =
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          existingContent;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      }
    } catch (error) {
      this.logger.warn(
        `Could not prepend summary to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Format time for display (HH:MM:SS)
   */
  private formatDisplayTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Parse display time (HH:MM:SS) back to seconds
   */
  private parseDisplayTime(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }
}
