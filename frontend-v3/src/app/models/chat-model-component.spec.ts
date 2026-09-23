import { isChatModelComponent } from './chat-model-component';

// Plain describe/it/expect only, so this runs under Karma/Jasmine (ng test) and Jest alike.
describe('isChatModelComponent', () => {
  it('keeps chat GGUF models', () => {
    expect(isChatModelComponent({ id: 'cogito-8b', kind: 'llama-model' })).toBe(true);
  });

  it('drops the scorer model and its projector (llama-model components, but not chat models)', () => {
    expect(isChatModelComponent({ id: 'scorer-qwen3.5-9b-bf16', kind: 'llama-model' })).toBe(false);
    expect(isChatModelComponent({ id: 'scorer-qwen3.5-9b-mmproj-f16', kind: 'llama-model' })).toBe(false);
  });

  it('drops everything that is not a llama-model', () => {
    expect(isChatModelComponent({ id: 'whisper-base', kind: 'whisper-model' })).toBe(false);
    expect(isChatModelComponent({ id: 'llama', kind: 'binary' })).toBe(false);
  });
});
