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
import {
  buildSectionIdentificationPrompt,
  interpolatePrompt,
  VIDEO_SUMMARY_PROMPT,
  TAG_EXTRACTION_PROMPT,
  QUOTE_EXTRACTION_PROMPT,
  SUGGESTED_TITLE_PROMPT,
  AnalysisCategory,
} from './prompts/analysis-prompts';

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

export interface AnalysisResult {
  sections_count: number;
  sections: AnalyzedSection[];
  tags?: Tags;
  description?: string;
  suggested_title?: string;
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
const CHUNK_MINUTES = 5;

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);

  constructor(
    private readonly aiProviderService: AIProviderService,
    private readonly ollamaService: OllamaService,
  ) {}

  /**
   * Main entry point: Analyze transcript using AI
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    console.log('=== AIAnalysisService.analyzeTranscript CALLED ===');
    console.log(`Provider: ${options.provider}, Model: ${options.model}`);
    this.logger.log('=== AIAnalysisService.analyzeTranscript CALLED ===');
    this.logger.log(`Provider: ${options.provider}, Model: ${options.model}`);

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
      onProgress,
    } = options;

    const sendProgress = (phase: string, progress: number, message: string) => {
      console.log(`[AI Analysis] ${progress}% - ${message}`);
      if (onProgress) {
        onProgress({ phase, progress, message });
      }
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

      // Chunk transcript into time-based segments
      const chunks = this.chunkTranscript(segments, CHUNK_MINUTES);
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
          );

          if (interestingSections && interestingSections.length > 0) {
            for (const section of interestingSections) {
              if (section.category === 'routine') {
                // For routine sections, just add with the quote from initial analysis
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

                  const analyzedSection: AnalyzedSection = {
                    category: 'routine',
                    description: section.description,
                    start_time: this.formatDisplayTime(startTime),
                    end_time: null,
                    quotes,
                  };

                  analyzedSections.push(analyzedSection);
                  this.writeSectionToFile(outputFile, analyzedSection);
                }
              } else {
                // For interesting sections, do detailed analysis
                const detailedAnalysis = await this.analyzeSectionDetail(
                  aiConfig,
                  section,
                  chunk.segments,
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

      // Extract tags
      sendProgress('analysis', 92, 'Extracting tags (people, topics)...');
      const tags = await this.extractTags(
        aiConfig,
        transcript,
        analyzedSections,
      );

      // Generate video summary
      sendProgress('analysis', 95, 'Generating video summary...');
      const summary = await this.generateSummary(
        aiConfig,
        analyzedSections,
        videoTitle,
      );

      // Prepend summary to file
      this.prependSummaryToFile(outputFile, summary);

      // Generate suggested title
      sendProgress('analysis', 98, 'Generating suggested title...');
      const suggestedTitle = await this.generateSuggestedTitle(
        aiConfig,
        videoTitle,
        summary,
        tags,
      );

      sendProgress('analysis', 100, 'Analysis complete!');

      return {
        sections_count: analyzedSections.length,
        sections: analyzedSections,
        tags,
        description: summary,
        suggested_title: suggestedTitle || undefined,
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
    const chunks: Chunk[] = [];

    if (!segments || segments.length === 0) {
      return [];
    }

    const chunkDuration = chunkMinutes * 60;
    const totalDuration = segments[segments.length - 1].end;
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
        chunkNum++;
      }

      currentStart = chunkEnd;
    }

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
          this.logger.debug(
            `Chunk ${chunkNum} analyzed successfully on attempt ${attempt}`,
          );
          return sections;
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

      // Ask AI to extract quotes
      const prompt = interpolatePrompt(QUOTE_EXTRACTION_PROMPT, {
        category: section.category,
        description: section.description,
        timestampedText: timestampedText.substring(0, 6000),
      });

      const response = await this.aiProviderService.generateText(prompt, config);

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
   * Uses fuzzy matching to find the best match
   */
  private findPhraseTimestamp(
    phrase: string,
    segments: Segment[],
    threshold: number = 0.5,
  ): number | null {
    if (!phrase || !segments || segments.length === 0) {
      return null;
    }

    const phraseWords = phrase.toLowerCase().trim().split(/\s+/);

    if (phraseWords.length === 0) {
      return null;
    }

    let bestScore = 0;
    let bestTimestamp: number | null = null;

    for (const segment of segments) {
      const segmentText = (segment.text || '').toLowerCase().trim();
      const segmentWords = segmentText.split(/\s+/);

      if (segmentWords.length === 0) continue;

      // Check if phrase words appear in segment (in order)
      let matches = 0;
      let segIdx = 0;

      for (const phraseWord of phraseWords) {
        while (segIdx < segmentWords.length) {
          if (
            segmentWords[segIdx].includes(phraseWord) ||
            phraseWord.includes(segmentWords[segIdx])
          ) {
            matches++;
            segIdx++;
            break;
          }
          segIdx++;
        }
      }

      const score = matches / phraseWords.length;

      if (score > bestScore) {
        bestScore = score;
        bestTimestamp = segment.start;
      }
    }

    if (bestScore >= threshold) {
      this.logger.debug(
        `Matched phrase '${phrase.substring(0, 50)}...' with score ${bestScore.toFixed(2)} at ${bestTimestamp}s`,
      );
      return bestTimestamp;
    } else {
      this.logger.debug(
        `Could not match phrase '${phrase.substring(0, 50)}...' (best score: ${bestScore.toFixed(2)})`,
      );
      return null;
    }
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
   * Extract tags from the transcript and analysis
   */
  private async extractTags(
    config: AIProviderConfig,
    transcriptText: string,
    analyzedSections: AnalyzedSection[],
  ): Promise<Tags> {
    try {
      const excerpt =
        transcriptText.length > 3000
          ? transcriptText.substring(0, 3000)
          : transcriptText;

      const sectionDescriptions = analyzedSections
        .map((s) => s.description)
        .filter((d) => d)
        .slice(0, 10);
      const sectionsContext = sectionDescriptions.join(' ');

      const prompt = interpolatePrompt(TAG_EXTRACTION_PROMPT, {
        sectionsContext,
        excerpt,
      });

      const response = await this.aiProviderService.generateText(prompt, config);

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
   * Generate a video summary based on analyzed sections
   */
  private async generateSummary(
    config: AIProviderConfig,
    analyzedSections: AnalyzedSection[],
    videoTitle: string,
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

      const prompt = interpolatePrompt(VIDEO_SUMMARY_PROMPT, {
        titleContext,
        sectionsSummary,
      });

      const response = await this.aiProviderService.generateText(prompt, config);

      if (response && response.text) {
        return response.text.trim();
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

      const prompt = interpolatePrompt(SUGGESTED_TITLE_PROMPT, {
        currentTitle,
        description: description.substring(0, 500),
        peopleTags,
        topicTags,
      });

      const response = await this.aiProviderService.generateText(prompt, config);

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

        // Length limit
        if (suggestedTitle.length > 200) {
          suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
          if (suggestedTitle.length > 200) {
            suggestedTitle = suggestedTitle.substring(0, 200).split(' ').slice(0, -1).join(' ');
          }
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
      this.logger.debug(`Parsing section response, length: ${response.length}`);

      // Try JSON parsing first
      const jsonMatch = response.match(/\{[\s\S]*"sections"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          if (data.sections && Array.isArray(data.sections)) {
            for (const section of data.sections) {
              if (
                section.start_phrase &&
                section.end_phrase &&
                section.category &&
                section.description
              ) {
                sections.push(section);
              }
            }
            this.logger.debug(
              `Parsed ${sections.length} sections from JSON`,
            );
            return sections;
          }
        } catch (jsonError) {
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
