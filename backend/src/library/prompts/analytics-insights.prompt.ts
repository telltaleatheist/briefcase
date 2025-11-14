/**
 * Generate prompt for library analytics AI insights
 */
export function buildAnalyticsInsightsPrompt(data: {
  totalVideos: number;
  analyzedCount: number;
  tagCount: number;
  topTopics: Array<{ name: string; type: string; count: number }>;
}): string {
  const { totalVideos, analyzedCount, tagCount, topTopics } = data;

  const completionRate = Math.round((analyzedCount / totalVideos) * 100);
  const topicsText = topTopics
    .map(t => `${t.name} (${t.type}): ${t.count} mentions`)
    .join('\n');

  return `Analyze this video library and provide insights:

LIBRARY STATS:
- Total Videos: ${totalVideos}
- Videos Analyzed: ${analyzedCount} (${completionRate}%)
- Unique Topics/Tags: ${tagCount}

TOP 30 TOPICS:
${topicsText}

Please provide:
1. **Library Overview**: 2-3 sentences summarizing what this library is about based on the topics
2. **Key Findings**: 3-5 bullet points of interesting patterns or insights
3. **Recommendations**: 2-3 suggestions for content to explore or areas to expand
4. **Content Gaps**: Areas that might be underrepresented

Format your response as JSON with this structure:
{
  "overview": "string",
  "keyFindings": ["string", "string", ...],
  "recommendations": ["string", "string", ...],
  "contentGaps": ["string", "string", ...]
}`;
}
