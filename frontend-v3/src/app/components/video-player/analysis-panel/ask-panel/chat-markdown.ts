import { Marked } from 'marked';

/**
 * AN ANSWER'S MARKDOWN, as HTML for the Ask bubble.
 *
 * Models write bold, lists, headings and inline code; the answer is rendered
 * with GFM line breaks, so a single newline still breaks the line as it did
 * when answers were plain text. Raw HTML in the answer (a model can quote the
 * transcript, which can say anything) is shown as text, never parsed; the
 * result still goes through Angular's [innerHTML] sanitizer, never around it.
 * Links keep their href; the panel opens them externally (onBubbleClick).
 */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

export function renderChatMarkdown(text: string): string {
  return markdown.parse(text ?? '', { async: false }) as string;
}
