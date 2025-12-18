/**
 * AI Analysis Service for ClipChimp Video Analysis
 *
 * Ported from Python video_analysis_service.py as part of the Python removal migration.
 * Handles transcript analysis using AI (Ollama, OpenAI, Claude).
 */

import { Injectable, Logger } from '@nestjs/common';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { OllamaService } from './ollama.service';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildSectionIdentificationPrompt,
  buildChapterDetectionPrompt,
  interpolatePrompt,
  VIDEO_SUMMARY_PROMPT,
  TAG_EXTRACTION_PROMPT,
  QUOTE_EXTRACTION_PROMPT,
  SUGGESTED_TITLE_PROMPT,
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

export interface Chunk {
  number: number;
  startTime: number;
  endTime: number;
  text: string;
  segments: Segment[];
}

export interface Quote {
  timestamp: string;
  text: string;
  significance: string;
}

export interface Section {
  start_phrase?: string;
  end_phrase?: string;
  category: string;
  description: string;
  quote?: string;
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
  description?: string;
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

export type AnalysisQuality = 'fast' | 'thorough';

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
  analysisQuality?: AnalysisQuality; // 'fast' = single-pass, 'thorough' = multi-pass (default for Ollama)
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

const REFUSAL_INDICATORS = [
  'I cannot',
  "I can't",
  "I'm not able to",
  "I don't feel comfortable",
  'I apologize, but',
  'against my guidelines',
  'content policy',
  "I'm designed to",
  "I shouldn't",
];

const MAX_RETRIES = 3;
const CHUNK_MINUTES_FAST = 15; // Larger chunks for fast mode (fewer API calls)
const CHUNK_MINUTES_THOROUGH = 5; // Smaller chunks for thorough mode (better detail)

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);
  private customPromptsCache: CustomPrompts | null = null;
  private customPromptsCacheTime = 0;
  private readonly PROMPTS_CACHE_TTL = 30000; // 30 seconds

  constructor(
    private readonly aiProviderService: AIProviderService,
    private readonly ollamaService: OllamaService,
  ) {}

  /**
   * Load custom prompts from config file
   * Caches for 30 seconds to avoid reading file on every call
   */
  private loadCustomPrompts(): CustomPrompts {
    const now = Date.now();

    // Check cache validity
    const cacheValid = this.customPromptsCache !== null &&
                       now - this.customPromptsCacheTime < this.PROMPTS_CACHE_TTL;
    if (cacheValid && this.customPromptsCache) {
      return this.customPromptsCache;
    }

    let prompts: CustomPrompts = {};

    try {
      const userDataPath = process.env.APPDATA ||
        (process.platform === 'darwin' ?
          path.join(process.env.HOME || '', 'Library', 'Application Support') :
          path.join(process.env.HOME || '', '.config'));
      const promptsPath = path.join(userDataPath, 'ClipChimp', 'analysis-prompts.json');

      if (fs.existsSync(promptsPath)) {
        const data = fs.readFileSync(promptsPath, 'utf8');
        const parsed = JSON.parse(data);
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
    // Return default
    return DEFAULT_PROMPTS[promptKey];
  }

  /**
   * Main entry point: Analyze transcript using AI
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    console.log('=== AIAnalysisService.analyzeTranscript CALLED ===');
    console.log(`Provider: ${options.provider}, Model: ${options.model}, Quality: ${options.analysisQuality || 'fast'}`);
    console.log(`[analyzeTranscript] SEGMENTS RECEIVED: ${options.segments?.length || 0}`);
    if (options.segments && options.segments.length > 0) {
      console.log(`[analyzeTranscript] First segment: start=${options.segments[0].start}, end=${options.segments[0].end}, text="${options.segments[0].text?.substring(0, 50)}"`);
      console.log(`[analyzeTranscript] Last segment: start=${options.segments[options.segments.length-1].start}, end=${options.segments[options.segments.length-1].end}`);
    } else {
      console.log(`[analyzeTranscript] WARNING: No segments or empty segments array!`);
    }
    this.logger.log('=== AIAnalysisService.analyzeTranscript CALLED ===');
    this.logger.log(`Provider: ${options.provider}, Model: ${options.model}, Quality: ${options.analysisQuality || 'fast'}`);

    const {
      provider,
      model,
      transcript,
      segments,
      outputFile,
      customInstructions = '',
      videoTitle = '',
      categories,
      apiKey,
      ollamaEndpoint,
      analysisQuality = 'fast', // Default to fast (cheaper) mode
      onProgress,
    } = options;

    // Determine chunk size based on quality mode
    const chunkMinutes = analysisQuality === 'thorough' ? CHUNK_MINUTES_THOROUGH : CHUNK_MINUTES_FAST;
    const isFastMode = analysisQuality === 'fast';

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
      sendProgress('analysis', 0, `Starting AI analysis with ${model} (${analysisQuality} mode)...`);

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

      // Chunk transcript into time-based segments
      const chunks = this.chunkTranscript(segments, chunkMinutes);
      const totalChunks = chunks.length;

      if (totalChunks === 1) {
        sendProgress('analysis', -1, 'Analyzing video...');
      } else {
        sendProgress(
          'analysis',
          0,
          `Starting analysis of ${totalChunks} chunks...`,
        );
      }

      const analyzedSections: AnalyzedSection[] = [];
      const failedChunks: number[] = [];
      let completedChunks = 0;

      const aiConfig: AIProviderConfig = {
        provider,
        model,
        apiKey,
        ollamaEndpoint,
      };

      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkNum = i + 1;

        try {
          const interestingSections = await this.identifyInterestingSections(
            aiConfig,
            chunk.text,
            chunkNum,
            customInstructions,
            videoTitle,
            categories || null,
            trackTokens,
          );

          if (interestingSections && interestingSections.length > 0) {
            for (const section of interestingSections) {
              // In fast mode OR for routine sections: use quote from initial analysis (single-pass)
              // In thorough mode for non-routine sections: do detailed analysis (two-pass)
              if (isFastMode || section.category === 'routine') {
                // Single-pass: use the quote from initial analysis
                const startPhrase = section.start_phrase || '';
                const startTime = this.findPhraseTimestamp(
                  startPhrase,
                  chunk.segments,
                );

                if (startTime !== null) {
                  const quoteText = section.quote || '';
                  const quotes: Quote[] = [];
                  if (quoteText) {
                    quotes.push({
                      timestamp: this.formatDisplayTime(startTime),
                      text: quoteText,
                      significance: section.description,
                    });
                  }

                  // For non-routine sections, try to find end time
                  let endTime: string | null = null;
                  if (section.category !== 'routine' && section.end_phrase) {
                    const endTimestamp = this.findPhraseTimestamp(
                      section.end_phrase,
                      chunk.segments,
                    );
                    if (endTimestamp !== null && endTimestamp > startTime) {
                      endTime = this.formatDisplayTime(endTimestamp);
                    }
                  }

                  const analyzedSection: AnalyzedSection = {
                    category: section.category,
                    description: section.description,
                    start_time: this.formatDisplayTime(startTime),
                    end_time: endTime,
                    quotes,
                  };

                  analyzedSections.push(analyzedSection);
                  this.writeSectionToFile(outputFile, analyzedSection);
                }
              } else {
                // Thorough mode: do detailed analysis for better quotes
                const detailedAnalysis = await this.analyzeSectionDetail(
                  aiConfig,
                  section,
                  chunk.segments,
                  trackTokens,
                );

                if (detailedAnalysis) {
                  analyzedSections.push(detailedAnalysis);
                  this.writeSectionToFile(outputFile, detailedAnalysis);
                }
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            `Chunk ${chunkNum} failed after retries: ${(error as Error).message}`,
          );
          this.logger.warn(
            `Skipping chunk ${chunkNum} and continuing with remaining chunks...`,
          );
          failedChunks.push(chunkNum);
        }

        completedChunks++;
        if (totalChunks > 1) {
          const chunkProgress = Math.round((completedChunks / totalChunks) * 100);
          sendProgress(
            'analysis',
            chunkProgress,
            `Completed chunk ${chunkNum}/${totalChunks}`,
          );
        }
      }

      // Report completion
      if (failedChunks.length > 0) {
        sendProgress(
          'analysis',
          100,
          `Analysis complete with ${failedChunks.length} failed chunks. Found ${analyzedSections.length} sections.`,
        );
        this.logger.warn(
          `Analysis completed but ${failedChunks.length} chunks failed: ${failedChunks.join(', ')}`,
        );
      } else {
        sendProgress(
          'analysis',
          100,
          `Analysis complete. Found ${analyzedSections.length} sections.`,
        );
      }

      // Handle empty results
      if (analyzedSections.length === 0) {
        this.logger.warn(
          'Analysis produced zero sections! Creating default routine section.',
        );

        const videoDuration = segments.length > 0 ? segments[segments.length - 1].end : 0;
        const transcriptLength = transcript.trim().length;

        let description: string;
        if (transcriptLength === 0) {
          description =
            'No speech or dialogue detected in this video. The video may contain only music, sound effects, or be silent.';
        } else if (transcriptLength < 50) {
          description =
            'Very brief or minimal audio content detected. The video appears to have little to no meaningful dialogue.';
        } else if (
          transcript.toLowerCase().includes('music') ||
          transcript.toLowerCase().includes('[music]')
        ) {
          description =
            'Video primarily contains music or ambient audio with minimal speech content.';
        } else {
          description =
            'Analysis could not identify specific notable sections. The content appears to be general discussion or routine material.';
        }

        const defaultSection: AnalyzedSection = {
          category: 'routine',
          description,
          start_time: '0:00',
          end_time: videoDuration > 0 ? this.formatDisplayTime(videoDuration) : null,
          quotes: [],
        };

        analyzedSections.push(defaultSection);
        this.writeSectionToFile(outputFile, defaultSection);
      }

      // Generate chapters (detects topic changes across the video)
      sendProgress('analysis', 88, 'Detecting chapters...');
      const chapters = await this.generateChapters(
        aiConfig,
        transcript,
        segments,
        videoTitle,
        trackTokens,
      );

      // Extract tags (uses section descriptions + quotes, not raw transcript)
      sendProgress('analysis', 92, 'Extracting tags (people, topics)...');
      const tags = await this.extractTags(
        aiConfig,
        analyzedSections,
        trackTokens,
      );

      // Generate video summary (uses section descriptions only)
      sendProgress('analysis', 95, 'Generating video summary...');
      const summary = await this.generateSummary(
        aiConfig,
        analyzedSections,
        videoTitle,
        trackTokens,
      );

      // Prepend summary to file
      this.prependSummaryToFile(outputFile, summary);

      // Generate suggested title (uses quotes, not raw transcript)
      sendProgress('analysis', 98, 'Generating suggested title...');
      const suggestedTitle = await this.generateSuggestedTitle(
        aiConfig,
        videoTitle,
        summary,
        tags,
        analyzedSections,
        trackTokens,
      );

      // Log token usage summary (use console.log for visibility in Electron)
      console.log('');
      console.log('='.repeat(60));
      console.log('AI ANALYSIS TOKEN USAGE SUMMARY');
      console.log('='.repeat(60));
      console.log(`Mode: ${analysisQuality}`);
      console.log(`Provider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(`API Calls: ${tokenStats.apiCalls}`);
      console.log(`Input Tokens: ${tokenStats.inputTokens.toLocaleString()}`);
      console.log(`Output Tokens: ${tokenStats.outputTokens.toLocaleString()}`);
      console.log(`Total Tokens: ${tokenStats.totalTokens.toLocaleString()}`);
      console.log('='.repeat(60));
      console.log('');

      // Also log via logger for NestJS logs
      this.logger.log('AI ANALYSIS TOKEN SUMMARY: ' +
        `apiCalls=${tokenStats.apiCalls}, ` +
        `inputTokens=${tokenStats.inputTokens}, ` +
        `outputTokens=${tokenStats.outputTokens}, ` +
        `totalTokens=${tokenStats.totalTokens}`
      );

      sendProgress('analysis', 100, 'Analysis complete!');

      // Debug: Log what we're returning
      console.log(`[analyzeTranscript] RETURNING: sections=${analyzedSections.length}, chapters=${chapters?.length || 0}, tags=${JSON.stringify(tags)}`);
      if (chapters && chapters.length > 0) {
        console.log(`[analyzeTranscript] Chapters being returned: ${JSON.stringify(chapters)}`);
      }

      return {
        sections_count: analyzedSections.length,
        sections: analyzedSections,
        chapters,
        tags,
        description: summary,
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
   * Use AI to identify interesting sections in a chunk - with retry logic
   */
  private async identifyInterestingSections(
    config: AIProviderConfig,
    chunkText: string,
    chunkNum: number,
    customInstructions: string,
    videoTitle: string,
    categories: AnalysisCategory[] | null,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<Section[]> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `[AI] Analyzing chunk ${chunkNum}, attempt ${attempt}/${MAX_RETRIES}`,
        );

        // Build title context section if provided
        let titleContext = '';
        if (videoTitle && videoTitle.trim()) {
          titleContext = `
**VIDEO CONTEXT:**
Video title/filename: ${videoTitle.trim()}

Use the video title as additional context to understand who is speaking and what the subject matter is.

`;
        }

        // Build custom instructions section if provided
        let customSection = '';
        if (customInstructions && customInstructions.trim()) {
          customSection = `
**CUSTOM USER INSTRUCTIONS:**
${customInstructions.trim()}

Pay special attention to the custom instructions above when analyzing the content.

`;
        }

        // Build prompt dynamically with user's categories
        const prompt = buildSectionIdentificationPrompt(
          titleContext,
          customSection,
          chunkNum,
          chunkText.substring(0, 8000), // Limit to ~8k chars
          categories,
        );

        const response = await this.aiProviderService.generateText(prompt, config);
        onTokens?.(response); // Track tokens

        if (!response || !response.text) {
          this.logger.warn(
            `AI returned empty response for chunk ${chunkNum} on attempt ${attempt}`,
          );
          if (attempt < MAX_RETRIES) continue;
          throw new Error(`Failed to get AI response after ${MAX_RETRIES} attempts`);
        }

        // Check for content policy refusals
        if (this.isRefusal(response.text)) {
          this.logger.warn(
            `AI may have refused to analyze chunk ${chunkNum}. Response starts with: ${response.text.substring(0, 200)}`,
          );
          if (attempt < MAX_RETRIES) continue;
          throw new Error(
            `AI refused to analyze chunk ${chunkNum} after ${MAX_RETRIES} attempts`,
          );
        }

        // Parse the response
        const sections = this.parseSectionResponse(response.text);

        if (sections && sections.length > 0) {
          // Validate categories - only allow categories that exist in user's settings
          const validCategoryNames = new Set(
            (categories || []).map(c => c.name.toLowerCase())
          );

          const validatedSections = sections.filter(section => {
            const categoryLower = section.category.toLowerCase();
            if (validCategoryNames.has(categoryLower)) {
              // Normalize category name to match config exactly
              const matchedCategory = (categories || []).find(
                c => c.name.toLowerCase() === categoryLower
              );
              if (matchedCategory) {
                section.category = matchedCategory.name;
              }
              return true;
            } else {
              this.logger.warn(
                `Rejected invalid category "${section.category}" - not in user's configured categories`
              );
              return false;
            }
          });

          if (validatedSections.length > 0) {
            this.logger.debug(
              `Chunk ${chunkNum} analyzed successfully on attempt ${attempt} (${validatedSections.length}/${sections.length} sections valid)`,
            );
            return validatedSections;
          }

          this.logger.warn(
            `All ${sections.length} sections from chunk ${chunkNum} had invalid categories`
          );
        }

        this.logger.warn(
          `Failed to parse any sections from AI response for chunk ${chunkNum} on attempt ${attempt}`,
        );
        if (attempt < MAX_RETRIES) continue;
        throw new Error(
          `Failed to parse sections from AI response after ${MAX_RETRIES} attempts`,
        );
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          this.logger.error(
            `Error on attempt ${attempt} for chunk ${chunkNum}: ${(error as Error).message}`,
          );
          continue;
        }
        throw new Error(`Chunk ${chunkNum} failed after ${MAX_RETRIES} attempts`);
      }
    }

    throw new Error(`Chunk ${chunkNum} failed unexpectedly`);
  }

  /**
   * Perform detailed analysis on a specific section
   */
  private async analyzeSectionDetail(
    config: AIProviderConfig,
    section: Section,
    allSegments: Segment[],
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<AnalyzedSection | null> {
    try {
      this.logger.debug(
        `Analyzing section: ${section.category} - ${section.description}`,
      );

      // Find timestamps for start and end phrases
      const startPhrase = section.start_phrase || '';
      const endPhrase = section.end_phrase || '';

      const startTime = this.findPhraseTimestamp(startPhrase, allSegments);
      const endTime = this.findPhraseTimestamp(endPhrase, allSegments);

      if (startTime === null || endTime === null) {
        this.logger.debug(
          'Could not correlate timestamps for section, skipping',
        );
        return null;
      }

      // Ensure end_time is after start_time
      let adjustedEndTime = endTime;
      if (endTime <= startTime) {
        this.logger.debug(
          `End time (${endTime}) not after start time (${startTime}), adjusting`,
        );
        adjustedEndTime = startTime + 30;
      }

      // Extract segments in this time range
      let sectionSegments = this.extractSegmentRange(
        allSegments,
        startTime,
        adjustedEndTime,
      );

      if (sectionSegments.length === 0) {
        // Try with a broader range
        sectionSegments = this.extractSegmentRange(
          allSegments,
          startTime - 5,
          adjustedEndTime + 5,
        );
      }

      if (sectionSegments.length === 0) {
        this.logger.debug('No segments found, skipping section');
        return null;
      }

      // Build timestamped transcript for this specific section
      const timestampedText = this.buildTimestampedTranscript(sectionSegments);

      // Ask AI to extract quotes (use custom prompt if configured)
      const prompt = interpolatePrompt(this.getPrompt('quotes'), {
        category: section.category,
        description: section.description,
        timestampedText: timestampedText.substring(0, 6000),
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response); // Track tokens

      if (!response || !response.text) {
        this.logger.debug('No response from AI for detailed analysis');
        return null;
      }

      const quotes = this.parseQuotesResponse(response.text);

      if (quotes && quotes.length > 0) {
        this.logger.debug(
          `Successfully extracted ${quotes.length} quotes from section`,
        );
        return {
          category: section.category,
          description: section.description,
          start_time: this.formatDisplayTime(startTime),
          end_time: this.formatDisplayTime(adjustedEndTime),
          quotes,
        };
      }

      this.logger.debug('No quotes parsed from response');
      return null;
    } catch (error) {
      this.logger.error(`Error in detailed analysis: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Find the timestamp for a specific phrase in the transcript segments
   * Uses substring matching on the full transcript, then maps back to segment timestamps
   */
  private findPhraseTimestamp(
    phrase: string,
    segments: Segment[],
    threshold: number = 0.5,
  ): number | null {
    if (!phrase || !segments || segments.length === 0) {
      return null;
    }

    const searchPhrase = phrase.toLowerCase().trim();
    if (searchPhrase.length === 0) {
      return null;
    }

    // Build full transcript with character position to timestamp mapping
    let fullText = '';
    const charToTimestamp: { pos: number; timestamp: number }[] = [];

    for (const segment of segments) {
      const segmentText = (segment.text || '').trim();
      if (segmentText.length > 0) {
        charToTimestamp.push({ pos: fullText.length, timestamp: segment.start });
        fullText += segmentText + ' ';
      }
    }

    const fullTextLower = fullText.toLowerCase();

    // Try exact substring match first
    let matchPos = fullTextLower.indexOf(searchPhrase);

    // If no exact match, try matching with normalized whitespace
    if (matchPos === -1) {
      const normalizedSearch = searchPhrase.replace(/\s+/g, ' ');
      const normalizedText = fullTextLower.replace(/\s+/g, ' ');
      matchPos = normalizedText.indexOf(normalizedSearch);
    }

    // If still no match, try word-based fuzzy matching
    if (matchPos === -1) {
      const phraseWords = searchPhrase.split(/\s+/).filter(w => w.length > 2);

      if (phraseWords.length > 0) {
        let bestPos = -1;
        let bestWordCount = 0;

        for (let i = 0; i < fullTextLower.length - 20; i += 10) {
          const window = fullTextLower.substring(i, i + searchPhrase.length + 50);
          let wordCount = 0;
          for (const word of phraseWords) {
            if (window.includes(word)) wordCount++;
          }
          if (wordCount > bestWordCount) {
            bestWordCount = wordCount;
            bestPos = i;
          }
        }

        if (bestWordCount >= phraseWords.length * threshold) {
          matchPos = bestPos;
        }
      }
    }

    if (matchPos === -1) {
      return null;
    }

    // Find the timestamp for this character position
    let timestamp = segments[0].start;
    for (const entry of charToTimestamp) {
      if (entry.pos <= matchPos) {
        timestamp = entry.timestamp;
      } else {
        break;
      }
    }

    return timestamp;
  }

  /**
   * Extract segments within a specific time range
   */
  private extractSegmentRange(
    segments: Segment[],
    startTime: number,
    endTime: number,
  ): Segment[] {
    return segments.filter(
      (seg) => seg.start >= startTime && seg.end <= endTime,
    );
  }

  /**
   * Build timestamped transcript for AI analysis
   */
  private buildTimestampedTranscript(segments: Segment[]): string {
    const lines: string[] = [];
    const limitedSegments = segments.slice(0, 200);

    for (const seg of limitedSegments) {
      const timestamp = this.formatDisplayTime(seg.start);
      lines.push(`[${timestamp}] ${seg.text.trim()}`);
    }

    return lines.join('\n');
  }

  /**
   * Build a summary of quotes from analyzed sections (for use in metadata extraction)
   * This allows us to skip sending raw transcript for tags/title generation
   */
  private buildQuotesSummary(analyzedSections: AnalyzedSection[]): string {
    const quotes: string[] = [];
    for (const section of analyzedSections.slice(0, 15)) {
      if (section.quotes && section.quotes.length > 0) {
        for (const quote of section.quotes.slice(0, 2)) {
          quotes.push(`"${quote.text}"`);
        }
      }
    }
    return quotes.join(' ').substring(0, 2000); // Limit to ~2k chars
  }

  private async extractTags(
    config: AIProviderConfig,
    analyzedSections: AnalyzedSection[],
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<Tags> {
    try {
      // Build context from section descriptions and quotes (no raw transcript needed)
      const sectionDescriptions = analyzedSections
        .map((s) => s.description)
        .filter((d) => d)
        .slice(0, 15);
      const sectionsContext = sectionDescriptions.join('. ');

      // Use quotes as excerpt instead of raw transcript
      const excerpt = this.buildQuotesSummary(analyzedSections);

      // Use custom tags prompt if configured
      const prompt = interpolatePrompt(this.getPrompt('tags'), {
        sectionsContext,
        excerpt: excerpt || sectionsContext, // Fallback to descriptions if no quotes
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response); // Track tokens

      if (response && response.text) {
        try {
          let cleanResponse = response.text.trim();

          // Remove markdown code blocks
          if (cleanResponse.startsWith('```')) {
            const lines = cleanResponse.split('\n');
            cleanResponse = lines
              .filter((l) => !l.startsWith('```'))
              .join('\n');
          }

          // Extract JSON object from response (handles extra text before/after)
          const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            this.logger.warn('No JSON object found in tag extraction response');
            return { people: [], topics: [] };
          }
          cleanResponse = jsonMatch[0];

          const tagsData = JSON.parse(cleanResponse);

          if (tagsData.people && tagsData.topics) {
            return {
              people: (tagsData.people as string[]).slice(0, 20),
              topics: (tagsData.topics as string[]).slice(0, 15),
            };
          }
        } catch (parseError) {
          this.logger.warn(
            `Failed to parse tag extraction JSON: ${(parseError as Error).message}`,
          );
        }
      }

      return { people: [], topics: [] };
    } catch (error) {
      this.logger.warn(`Tag extraction failed: ${(error as Error).message}`);
      return { people: [], topics: [] };
    }
  }

  /**
   * Generate chapters by detecting topic changes in the transcript
   */
  private async generateChapters(
    config: AIProviderConfig,
    transcript: string,
    segments: Segment[],
    videoTitle: string,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<Chapter[]> {
    try {
      if (!transcript || !segments || segments.length === 0) {
        this.logger.warn('No transcript or segments available for chapter generation');
        return [];
      }

      const titleContext = videoTitle
        ? `Video title: ${videoTitle}\n`
        : '';

      // Build timestamped transcript for chapter detection
      // Use a condensed format to fit in context
      const timestampedLines: string[] = [];
      let currentMinute = -1;

      for (const segment of segments) {
        const minute = Math.floor(segment.start / 60);
        // Add timestamp every minute
        if (minute > currentMinute) {
          currentMinute = minute;
          const timeStr = this.formatDisplayTime(segment.start);
          timestampedLines.push(`\n[${timeStr}]`);
        }
        timestampedLines.push(segment.text);
      }

      const chunkText = timestampedLines.join(' ').substring(0, 30000); // Limit to ~30k chars

      const prompt = buildChapterDetectionPrompt(titleContext, chunkText);

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response);

      if (!response || !response.text) {
        this.logger.warn('No response from AI for chapter generation');
        return [];
      }

      // Parse the response
      let cleanResponse = response.text.trim();

      // Remove markdown code blocks
      if (cleanResponse.startsWith('```')) {
        const lines = cleanResponse.split('\n');
        cleanResponse = lines
          .filter((l) => !l.startsWith('```'))
          .join('\n');
      }

      // Extract JSON object
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON object found in chapter detection response');
        return [];
      }
      cleanResponse = jsonMatch[0];

      const chaptersData = JSON.parse(cleanResponse);

      if (!chaptersData.chapters || !Array.isArray(chaptersData.chapters)) {
        this.logger.warn('Invalid chapters data in response');
        return [];
      }

      // Convert raw chapters to Chapter interface with timestamps
      const chapters: Chapter[] = [];
      const videoDuration = segments[segments.length - 1].end;

      console.log(`[generateChapters] AI returned ${chaptersData.chapters.length} raw chapters, video duration: ${videoDuration}s`);

      for (let i = 0; i < chaptersData.chapters.length; i++) {
        const rawChapter = chaptersData.chapters[i];
        const startPhrase = rawChapter.start_phrase || '';
        const title = rawChapter.title || `Chapter ${i + 1}`;

        console.log(`[generateChapters] Processing chapter ${i + 1}: title="${title}", start_phrase="${startPhrase.substring(0, 40)}..."`);

        // Find the timestamp for this chapter's start phrase
        const startTime = this.findPhraseTimestamp(startPhrase, segments);

        if (startTime !== null) {
          // Calculate end time (next chapter's start or video end)
          let endTime = videoDuration;

          if (i < chaptersData.chapters.length - 1) {
            const nextPhrase = chaptersData.chapters[i + 1].start_phrase || '';
            const nextStart = this.findPhraseTimestamp(nextPhrase, segments);
            if (nextStart !== null) {
              endTime = nextStart;
            }
          }

          const chapter = {
            sequence: i + 1,
            start_time: this.formatDisplayTime(startTime),
            end_time: this.formatDisplayTime(endTime),
            title,
          };
          console.log(`[generateChapters] Created chapter: ${JSON.stringify(chapter)}`);
          chapters.push(chapter);
        } else {
          console.log(`[generateChapters] Could not find timestamp for chapter phrase: "${startPhrase.substring(0, 50)}..."`);
          this.logger.debug(`Could not find timestamp for chapter phrase: "${startPhrase.substring(0, 50)}..."`);
        }
      }

      // If we couldn't find any chapters, create a default one
      if (chapters.length === 0 && videoDuration > 0) {
        console.log(`[generateChapters] No chapters found from phrases, creating default chapter`);
        chapters.push({
          sequence: 1,
          start_time: '0:00',
          end_time: this.formatDisplayTime(videoDuration),
          title: 'Full Video',
        });
      }

      console.log(`[generateChapters] Final chapters count: ${chapters.length}`);
      this.logger.log(`Generated ${chapters.length} chapters`);
      return chapters;
    } catch (error) {
      this.logger.warn(`Chapter generation failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Generate a video summary based on analyzed sections
   */
  private async generateSummary(
    config: AIProviderConfig,
    analyzedSections: AnalyzedSection[],
    videoTitle: string,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string> {
    try {
      if (!analyzedSections || analyzedSections.length === 0) {
        return 'No content could be analyzed in this video.';
      }

      const sectionsList: string[] = [];
      const sectionsToProcess = analyzedSections.slice(0, 20);

      for (let i = 0; i < sectionsToProcess.length; i++) {
        const section = sectionsToProcess[i];
        const category = section.category || 'unknown';
        const description = section.description || 'No description';
        const startTime = section.start_time || '?';
        sectionsList.push(
          `${i + 1}. [${startTime}] ${description} [${category}]`,
        );
      }

      const sectionsSummary = sectionsList.join('\n');
      const titleContext = videoTitle
        ? `\nVideo title/filename: ${videoTitle}\n`
        : '';

      // Use custom description prompt if configured
      const prompt = interpolatePrompt(this.getPrompt('description'), {
        titleContext,
        sectionsSummary,
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response); // Track tokens

      if (response && response.text) {
        const summary = response.text.trim();

        // Reject AI refusals/meta-commentary
        const invalidPatterns = [
          /^i apologize/i,
          /^i'm sorry/i,
          /^i cannot/i,
          /^i don't have access/i,
          /^i do not have access/i,
          /^unfortunately/i,
          /^as an ai/i,
          /^i'm unable/i,
          /^without being able/i,
          /^based on the filename/i,
        ];
        for (const pattern of invalidPatterns) {
          if (pattern.test(summary)) {
            this.logger.warn(`Rejected AI refusal response: "${summary.substring(0, 100)}..."`);
            break; // Fall through to fallback summary
          }
        }

        // If summary looks valid, return it
        if (!invalidPatterns.some(p => p.test(summary))) {
          return summary;
        }
      }

      // Fallback summary
      const routineCount = analyzedSections.filter(
        (s) => s.category === 'routine',
      ).length;
      const interestingCount = analyzedSections.length - routineCount;

      if (interestingCount === 0) {
        return 'This video contains routine content with no particularly notable sections identified.';
      } else {
        const categories = [
          ...new Set(
            analyzedSections
              .filter((s) => s.category !== 'routine')
              .map((s) => s.category),
          ),
        ];
        return `This video contains ${interestingCount} notable section(s) including: ${categories.join(', ')}.`;
      }
    } catch (error) {
      this.logger.error(`Summary generation failed: ${(error as Error).message}`);
      return 'Summary could not be generated for this video.';
    }
  }

  /**
   * Generate a suggested filename based on analysis results
   */
  private async generateSuggestedTitle(
    config: AIProviderConfig,
    currentTitle: string,
    description: string,
    tags: Tags,
    analyzedSections: AnalyzedSection[],
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    try {
      const peopleTags =
        tags.people && tags.people.length > 0
          ? tags.people.slice(0, 5).join(', ')
          : 'None';
      const topicTags =
        tags.topics && tags.topics.length > 0
          ? tags.topics.slice(0, 5).join(', ')
          : 'None';

      // Use quotes summary instead of raw transcript
      const transcriptExcerpt = this.buildQuotesSummary(analyzedSections) || description;

      // Use custom title prompt if configured
      const prompt = interpolatePrompt(this.getPrompt('title'), {
        currentTitle,
        description: description.substring(0, 500),
        peopleTags,
        topicTags,
        transcriptExcerpt,
      });

      const response = await this.aiProviderService.generateText(prompt, config);
      onTokens?.(response); // Track tokens

      if (response && response.text) {
        let suggestedTitle = response.text.trim();

        // Remove quotes
        if (
          suggestedTitle.startsWith('"') &&
          suggestedTitle.endsWith('"')
        ) {
          suggestedTitle = suggestedTitle.slice(1, -1);
        }

        // Remove file extension
        if (suggestedTitle.includes('.')) {
          suggestedTitle = suggestedTitle.split('.')[0];
        }

        // Remove date prefix
        suggestedTitle = suggestedTitle.replace(
          /^\d{4}-\d{2}-\d{2}[-\s]*/,
          '',
        );

        // Lowercase and clean
        suggestedTitle = suggestedTitle.toLowerCase().trim();

        // Remove invalid filesystem characters
        suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');

        // Remove periods
        suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
        suggestedTitle = suggestedTitle.replace(/\.$/, '');

        // Clean up multiple spaces
        suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

        // Reject AI meta-commentary (not actual titles)
        const invalidPatterns = [
          /^based on/i,
          /^the transcript/i,
          /^this video/i,
          /^i would/i,
          /^i suggest/i,
          /^here is/i,
          /^the suggested/i,
          /^a suggested/i,
          /^filename:/i,
          /^title:/i,
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
          if (suggestedTitle.length > 200) {
            suggestedTitle = suggestedTitle.substring(0, 200).split(' ').slice(0, -1).join(' ');
          }
        }

        // Reject if too short (likely garbage)
        if (suggestedTitle.length < 10) {
          this.logger.warn(`Rejected too-short AI title: "${suggestedTitle}"`);
          return null;
        }

        this.logger.debug(`Generated suggested title: ${suggestedTitle}`);
        return suggestedTitle || null;
      }

      return null;
    } catch (error) {
      this.logger.warn(
        `Suggested title generation failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Check if response indicates content policy refusal
   */
  private isRefusal(response: string): boolean {
    const start = response.substring(0, 200).toLowerCase();
    return REFUSAL_INDICATORS.some((indicator) =>
      start.includes(indicator.toLowerCase()),
    );
  }

  /**
   * Parse AI response to extract sections - supports both JSON and legacy text format
   */
  private parseSectionResponse(response: string): Section[] {
    const sections: Section[] = [];

    try {
      console.log(`[parseSectionResponse] Raw AI response (first 500 chars): ${response.substring(0, 500)}`);
      this.logger.debug(`Parsing section response, length: ${response.length}`);

      // Try JSON parsing first
      const jsonMatch = response.match(/\{[\s\S]*"sections"[\s\S]*\}/);
      console.log(`[parseSectionResponse] JSON match found: ${!!jsonMatch}`);
      if (jsonMatch) {
        console.log(`[parseSectionResponse] JSON matched: ${jsonMatch[0].substring(0, 300)}...`);
        try {
          const data = JSON.parse(jsonMatch[0]);
          console.log(`[parseSectionResponse] Parsed JSON, sections array length: ${data.sections?.length}`);
          if (data.sections && Array.isArray(data.sections)) {
            for (const section of data.sections) {
              console.log(`[parseSectionResponse] Section: start_phrase="${section.start_phrase}", end_phrase="${section.end_phrase}", category="${section.category}", description="${section.description?.substring(0, 50)}"`);
              if (
                section.start_phrase &&
                section.end_phrase &&
                section.category &&
                section.description
              ) {
                // Safety net: if AI combined categories with comma, split them into separate sections
                const categoryStr = section.category as string;
                if (categoryStr.includes(',')) {
                  const individualCategories = categoryStr.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 0);
                  console.log(`[parseSectionResponse] Splitting combined category "${categoryStr}" into ${individualCategories.length} separate sections`);
                  for (const cat of individualCategories) {
                    sections.push({
                      ...section,
                      category: cat,
                    });
                  }
                } else {
                  sections.push(section);
                }
              } else {
                console.log(`[parseSectionResponse] SKIPPED section - missing fields. Has: start_phrase=${!!section.start_phrase}, end_phrase=${!!section.end_phrase}, category=${!!section.category}, description=${!!section.description}`);
              }
            }
            this.logger.debug(
              `Parsed ${sections.length} sections from JSON`,
            );
            return sections;
          }
        } catch (jsonError) {
          console.log(`[parseSectionResponse] JSON parse error: ${(jsonError as Error).message}`);
          this.logger.warn(
            `JSON parsing failed: ${(jsonError as Error).message}`,
          );
        }
      }

      // Legacy text-based parsing fallback
      if (
        !response.includes('Section ') &&
        !response.includes('section ')
      ) {
        this.logger.debug('No section markers found in response');
        return [];
      }

      let parts: string[] = [];
      for (const pattern of ['Section ', 'section ']) {
        if (response.includes(pattern)) {
          parts = response.split(pattern).slice(1);
          break;
        }
      }

      for (const part of parts) {
        const lines = part.trim().split('\n');
        const sectionData: Partial<Section> = {};

        for (const line of lines) {
          const lineLower = line.toLowerCase().trim();
          if (lineLower.startsWith('start:')) {
            sectionData.start_phrase = line.split(':', 2)[1]?.trim().replace(/^["']|["']$/g, '');
          } else if (lineLower.startsWith('end:')) {
            sectionData.end_phrase = line.split(':', 2)[1]?.trim().replace(/^["']|["']$/g, '');
          } else if (lineLower.startsWith('category:')) {
            sectionData.category = line.split(':', 2)[1]?.trim();
          } else if (lineLower.startsWith('description:')) {
            sectionData.description = line.split(':', 2)[1]?.trim();
          }
        }

        if (
          sectionData.start_phrase &&
          sectionData.end_phrase &&
          sectionData.category &&
          sectionData.description
        ) {
          sections.push(sectionData as Section);
        }
      }

      this.logger.debug(
        `Parsed ${sections.length} sections from legacy format`,
      );
    } catch (error) {
      this.logger.error(`Error parsing sections: ${(error as Error).message}`);
    }

    return sections;
  }

  /**
   * Parse AI response to extract quotes - supports both JSON and legacy text format
   */
  private parseQuotesResponse(response: string): Quote[] {
    const quotes: Quote[] = [];

    try {
      this.logger.debug(`Parsing quotes response, length: ${response.length}`);

      // Try JSON parsing first
      const jsonMatch = response.match(/\{[\s\S]*"quotes"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          if (data.quotes && Array.isArray(data.quotes)) {
            for (const quote of data.quotes) {
              if (quote.timestamp && quote.text && quote.significance) {
                quotes.push(quote);
              }
            }
            this.logger.debug(`Parsed ${quotes.length} quotes from JSON`);
            return quotes;
          }
        } catch (jsonError) {
          this.logger.warn(
            `JSON parsing failed: ${(jsonError as Error).message}`,
          );
        }
      }

      // Legacy text-based parsing fallback
      let textToParse = response;
      for (const marker of ['Key quotes:', 'Key Quotes:', 'QUOTES:']) {
        if (response.includes(marker)) {
          textToParse = response.split(marker)[1]?.trim() || '';
          break;
        }
      }

      if (!textToParse) return [];

      let currentQuote: Partial<Quote> = {};

      for (let line of textToParse.split('\n')) {
        line = line.trim();

        // Remove leading numbers
        if (line.match(/^\d+[\.\)\s]/)) {
          line = line.replace(/^\d+[\.\)\s]+/, '');
        }

        const lineLower = line.toLowerCase();
        if (lineLower.includes('timestamp:')) {
          if (currentQuote.timestamp) {
            if (
              currentQuote.text &&
              currentQuote.significance
            ) {
              quotes.push(currentQuote as Quote);
            }
          }
          currentQuote = {};
          const ts = line.split(/timestamp:/i)[1]?.trim().replace(/[\[\]()]/g, '');
          currentQuote.timestamp = ts;
        } else if (lineLower.includes('quote:')) {
          currentQuote.text = line.split(/quote:/i)[1]?.trim().replace(/^["']|["']$/g, '');
        } else if (lineLower.includes('significance:')) {
          currentQuote.significance = line.split(/significance:/i)[1]?.trim();
        }
      }

      // Add last quote
      if (
        currentQuote.timestamp &&
        currentQuote.text &&
        currentQuote.significance
      ) {
        quotes.push(currentQuote as Quote);
      }

      this.logger.debug(`Parsed ${quotes.length} quotes from legacy format`);
    } catch (error) {
      this.logger.error(`Error parsing quotes: ${(error as Error).message}`);
    }

    return quotes;
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

      if (section.category === 'routine') {
        content = `**${section.start_time} - ${section.description} [routine]**\n\n`;
      } else {
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
   * Format time for display (MM:SS or H:MM:SS)
   */
  private formatDisplayTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }
}
