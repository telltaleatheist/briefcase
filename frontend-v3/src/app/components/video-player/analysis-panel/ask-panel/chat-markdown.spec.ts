import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { SecurityContext } from '@angular/core';
import { renderChatMarkdown } from './chat-markdown';

/** Answers render as Markdown; anything that would run is text, and the sanitizer still has the last word. */
describe('renderChatMarkdown', () => {
  it('bold, a list, and single newlines that still break', () => {
    expect(renderChatMarkdown('There are **two** parts:\n\n*   The budget\n*   Trump')).toBe(
      '<p>There are <strong>two</strong> parts:</p>\n<ul>\n<li>The budget</li>\n<li>Trump</li>\n</ul>\n');
    expect(renderChatMarkdown('One line\nthe next')).toBe('<p>One line<br>the next</p>\n');
  });

  it('a <script> in the text is shown as text, never run, before and after sanitizing', () => {
    const html = renderChatMarkdown('He said <script>alert(1)</script> on air.\n\n<img src=x onerror="alert(2)">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const safe = TestBed.inject(DomSanitizer).sanitize(SecurityContext.HTML, html)!;
    const host = document.createElement('div');
    host.innerHTML = safe;
    expect(host.querySelector('script, img')).toBeNull();
    expect(host.textContent).toContain('<script>alert(1)</script>');
  });
});
