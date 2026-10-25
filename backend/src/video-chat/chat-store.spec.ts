import { describe, expect, it } from '@jest/globals';
import { answerSetName, fallbackSetName, tidySetName } from './chat-store';

/**
 * An answer's markers go into one marker set, named by the model with its
 * add_marker calls (`set`), tidied; when it names none, the thread's title
 * (its first question) made into a name, with no model call.
 */
describe('set names', () => {
  it('tidied: one line, no wrapping quotes or end punctuation, sentence case, cut at a word', () => {
    expect(tidySetName('  trump\n  mentions. ')).toBe('Trump mentions');
    expect(tidySetName('"Reaction moments"')).toBe('Reaction moments');
    expect(tidySetName('every single time the host mentions the budget fight in Congress')).toBe('Every single time the host mentions the');
    expect(tidySetName(' ?! ')).toBe('');
  });

  it('the first non-empty set among the answer\'s markers wins, across rounds', () => {
    expect(answerSetName([{ set: null }, { set: '  ' }, { set: 'trump mentions' }, { set: 'Other' }], 'Trump?')).toBe('Trump mentions');
  });

  it('none named: the thread title, without the asking', () => {
    expect(answerSetName([{ set: null }], 'Is there a section where Trump is discussed? Mark it.')).toBe('Section where Trump is discussed');
    expect(answerSetName([], 'Can you find all the reaction moments?')).toBe('Reaction moments');
    expect(fallbackSetName('Mark the budget fight')).toBe('Budget fight');
    expect(fallbackSetName('What is this video about, in one long sentence that goes on…')).toBe('What is this video about, in one long');
    expect(fallbackSetName('')).toBe('Ask');
  });
});
