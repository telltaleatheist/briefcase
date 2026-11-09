import {
  DEFAULT_PLAYER_VOLUME,
  createEditorTab,
  getDefaultPlayerVolume,
  setDefaultPlayerVolume,
} from './video-editor.model';

describe('default player volume', () => {
  const KEY = 'briefcase-player-default-volume';

  afterEach(() => localStorage.removeItem(KEY));

  it('opens at 250% until the viewer sets a default', () => {
    localStorage.removeItem(KEY);
    expect(getDefaultPlayerVolume()).toBe(DEFAULT_PLAYER_VOLUME);
  });

  it('opens new tabs at the saved default', () => {
    setDefaultPlayerVolume(3.33);
    expect(getDefaultPlayerVolume()).toBe(3.33);
    expect(createEditorTab('id', '/v.mp4', 'Title', undefined).editorState.volume).toBe(3.33);
  });

  it('keeps a saved default of 0 (muted)', () => {
    setDefaultPlayerVolume(0);
    expect(getDefaultPlayerVolume()).toBe(0);
  });

  it('ignores a corrupt or out-of-range saved value', () => {
    localStorage.setItem(KEY, 'loud');
    expect(getDefaultPlayerVolume()).toBe(DEFAULT_PLAYER_VOLUME);
    localStorage.setItem(KEY, '42');
    expect(getDefaultPlayerVolume()).toBe(DEFAULT_PLAYER_VOLUME);
  });
});
