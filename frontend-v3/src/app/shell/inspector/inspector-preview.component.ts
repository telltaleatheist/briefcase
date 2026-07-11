import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  signal,
  untracked,
  viewChild
} from '@angular/core';

/** idle → poster + play button; playing → <video>; error → poster + note. */
type PreviewMode = 'idle' | 'playing' | 'error';

/**
 * Lightweight in-inspector audition of the selected video.
 *
 * Shows the cascade thumbnail (poster) with a play affordance; the first click
 * lazily mounts a native `<video>` (no element, no `src`, until then) and plays
 * it so the user can listen for a moment. This is deliberately not the editor —
 * no waveform, no timeline, no video.js.
 *
 * Teardown discipline: the inspector's tab panels stay mounted (display:none)
 * and selection swaps data in place, so a hidden `<video>` would keep playing
 * audio. Playback is therefore torn down whenever the source (`streamUrl`)
 * changes or the Info tab stops being visible (`active`), and on destroy.
 */
@Component({
  selector: 'app-inspector-preview',
  standalone: true,
  templateUrl: './inspector-preview.component.html',
  styleUrls: ['./inspector-preview.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InspectorPreviewComponent implements OnDestroy {
  /** Poster still shown until the user presses play (the cascade thumbnail). */
  readonly posterUrl = input.required<string>();
  /** Streamable source, built by the panel from the item id (Range-capable). */
  readonly streamUrl = input.required<string>();
  /**
   * Whether the Info tab is the currently visible tab. A hidden panel keeps a
   * `<video>` playing audio, so when this drops to false we stop playback.
   */
  readonly active = input.required<boolean>();

  readonly mode = signal<PreviewMode>('idle');

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  constructor() {
    // Teardown: any change of source (selection changed) or loss of tab
    // visibility returns us to the idle poster and stops playback. The pause
    // happens here, while the element is still in the DOM, before the template
    // unmounts it. The element read is untracked so mounting the <video> on
    // play doesn't feed back into this effect and immediately tear it down.
    effect(() => {
      void this.streamUrl();
      void this.active();
      this.stop();
    }, { allowSignalWrites: true });

    // Autoplay on the first click: mode → 'playing' mounts the <video>, the
    // viewChild resolves, and we start it. Triggering from within the click's
    // transient user activation keeps unmuted playback allowed.
    effect(() => {
      if (this.mode() !== 'playing') return;
      const el = this.video()?.nativeElement;
      if (!el) return;
      void el.play().catch(() => {
        // A genuine decode failure surfaces via the (error) handler → the
        // "Can't preview this format" note. This catch only swallows the
        // benign cases — a play() aborted by a fast teardown, or an autoplay
        // policy refusal for which the native controls remain available.
      });
    });
  }

  /** First click on the poster: lazily mount and start the <video>. */
  play(): void {
    if (this.mode() === 'playing') return;
    this.mode.set('playing');
  }

  /** Decode/format failure — fall back to the poster with a quiet note. */
  onError(): void {
    this.mode.set('error');
  }

  /** Pause, release the source, and return to the idle poster. */
  private stop(): void {
    const el = untracked(this.video)?.nativeElement;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.mode.set('idle');
  }

  ngOnDestroy(): void {
    this.stop();
  }
}
