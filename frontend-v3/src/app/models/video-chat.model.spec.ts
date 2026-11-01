import { HttpErrorResponse } from '@angular/common/http';
import { chatErrorMessage, chatPhaseLabel, formatChatRange, formatChatTime, isChatCancelled } from './video-chat.model';

describe('video-chat model helpers', () => {
  it('formats times as HH:MM:SS', () => {
    expect(formatChatTime(0)).toBe('00:00:00');
    expect(formatChatTime(332.9)).toBe('00:05:32');
    expect(formatChatTime(3725)).toBe('01:02:05');
    expect(formatChatTime(-4)).toBe('00:00:00');
    expect(formatChatTime(NaN)).toBe('00:00:00');
  });

  it('formats a chip range with an en dash, one time for a point', () => {
    expect(formatChatRange(65, 130)).toBe('00:01:05–00:02:10');
    expect(formatChatRange(65, 65.4)).toBe('00:01:05');
  });

  it('labels the socket phases', () => {
    expect(chatPhaseLabel('loading-model')).toBe('Loading model…');
    expect(chatPhaseLabel('thinking')).toBe('Thinking…');
    expect(chatPhaseLabel('placing-markers')).toBe('Placing markers…');
    expect(chatPhaseLabel('searching', 'Trump')).toBe('Searching “Trump”…');
    expect(chatPhaseLabel('reading', '00:42:10–00:50:30')).toBe('Reading 00:42:10–00:50:30…');
    expect(chatPhaseLabel('reading', 'the outline')).toBe('Reading the outline…');
    expect(chatPhaseLabel('searching')).toBe('Searching…');
    expect(chatPhaseLabel(null)).toBe('Sending…');
  });

  it('reads a stopped send (499 cancelled) as no error', () => {
    const err = (status: number, error: unknown) => new HttpErrorResponse({ status, error });
    expect(isChatCancelled(err(499, { code: 'cancelled', message: 'The question was cancelled.' }))).toBeTrue();
    expect(isChatCancelled(err(499, null))).toBeTrue();
    expect(isChatCancelled(err(422, { code: 'context_too_small' }))).toBeFalse();
    expect(isChatCancelled(new Error('cancelled'))).toBeFalse();
  });

  it("uses the backend's sentence for 409 / 422 / 5xx", () => {
    const err = (status: number, error: unknown) => new HttpErrorResponse({ status, error });
    expect(chatErrorMessage(err(409, { code: 'crucible_required', message: 'Crucible is not running.' }))).toBe('Crucible is not running.');
    expect(chatErrorMessage(err(422, { code: 'context_too_small', message: 'Too small: 4,096 tokens.' }))).toBe('Too small: 4,096 tokens.');
    expect(chatErrorMessage(err(422, { code: 'context_too_small' }))).toContain('too small');
    expect(chatErrorMessage(err(422, { code: 'no_transcript' }))).toContain('no transcript');
    expect(chatErrorMessage(err(502, { code: 'upstream', message: 'The model crashed.' }))).toBe('The model crashed.');
    expect(chatErrorMessage(err(500, null))).toContain('500');
    expect(chatErrorMessage(err(0, null))).toContain('could not be reached');
  });
});
