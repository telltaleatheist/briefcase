import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';

type Pair = 'h' | 'm' | 's';

interface BoxDef {
  readonly index: number;
  readonly pair: Pair;
  readonly aria: string;
}

/** Six-box layout: [H][H] : [M][M] : [S][S]. */
const BOXES: readonly BoxDef[] = [
  { index: 0, pair: 'h', aria: 'Hours tens digit' },
  { index: 1, pair: 'h', aria: 'Hours ones digit' },
  { index: 2, pair: 'm', aria: 'Minutes tens digit' },
  { index: 3, pair: 'm', aria: 'Minutes ones digit' },
  { index: 4, pair: 's', aria: 'Seconds tens digit' },
  { index: 5, pair: 's', aria: 'Seconds ones digit' },
];

const EMPTY: readonly string[] = ['', '', '', '', '', ''];

interface Evaluated {
  /** Parsed total seconds, or null when every box is empty. */
  readonly value: number | null;
  readonly minutesInvalid: boolean;
  readonly secondsInvalid: boolean;
  readonly invalid: boolean;
}

/**
 * Creamsicle OTP-style timecode input.
 *
 * Six single-digit boxes grouped in pairs — [H][H] : [M][M] : [S][S] — that
 * behave like a one-time-passcode field: typing a digit auto-advances, backspace
 * walks back, arrows move focus, paste right-aligns a "1:23:45" / "012345" / "90"
 * string across the boxes. Value in via the `seconds` signal input (null/0 shows
 * empty), value out via `secondsChange` (parsed total seconds, or null when all
 * boxes are empty).
 *
 * Honest state over silent correction: when a minutes or seconds *pair* completes
 * above 59 it is flagged invalid (red border) rather than clamped, and the
 * `invalid` output lets the host disable submit. Hours are never range-limited.
 *
 * Dumb + OnPush + token-driven; the only imperative DOM touch is focusing the box
 * elements via `viewChildren`, which is legitimate for a roving-focus widget.
 */
@Component({
  selector: 'ui-timecode-input',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tc" role="group" [attr.aria-label]="label()">
      @for (box of boxes; track box.index) {
        <input
          #box
          class="tc-box"
          [class.invalid]="boxInvalid(box.pair)"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          maxlength="1"
          [value]="digits()[box.index]"
          [attr.aria-label]="box.aria"
          (focus)="onFocus($event)"
          (input)="onInput($event, box.index)"
          (keydown)="onKeydown($event, box.index)"
          (paste)="onPaste($event)" />
        @if (box.index === 1 || box.index === 3) {
          <span class="tc-colon" aria-hidden="true">:</span>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: inline-block; }

    .tc {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }

    .tc-box {
      width: 22px;
      height: 30px;
      padding: 0;
      text-align: center;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 15px;
      font-variant-numeric: tabular-nums;
      caret-color: var(--primary-orange);
      transition: border-color 120ms ease, box-shadow 120ms ease;

      &:focus {
        outline: none;
        border-color: var(--primary-orange);
        box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.25);
      }

      &.invalid {
        border-color: var(--error);

        &:focus {
          border-color: var(--error);
          box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.22);
        }
      }
    }

    .tc-colon {
      color: var(--text-tertiary);
      font-weight: 600;
      user-select: none;
      padding: 0 1px;
    }
  `]
})
export class UiTimecodeInputComponent {
  /** Group aria-label (screen-reader name for the whole field). */
  label = input('Timecode');
  /** Value in: total seconds. null or 0 renders empty boxes. */
  seconds = input<number | null>(null);

  /** Value out: parsed total seconds, or null when every box is empty. */
  readonly secondsChange = output<number | null>();
  /** True when a completed minutes/seconds pair exceeds 59. */
  readonly invalid = output<boolean>();

  protected readonly boxes = BOXES;
  protected readonly digits = signal<string[]>([...EMPTY]);

  private boxEls = viewChildren<ElementRef<HTMLInputElement>>('box');
  private parsed = computed(() => this.evaluate(this.digits()));
  /** Guards the seconds→boxes sync against our own emit feedback. */
  private lastSyncedSeconds: number | null | undefined = undefined;

  constructor() {
    // Seed / reset boxes from the `seconds` input. Only rebuilds on a genuine
    // external change: our own emits round-trip to the same normalized value, so
    // the guard skips them and never clobbers a partial entry or moves the caret.
    effect(() => {
      const incoming = this.norm(this.seconds());
      if (incoming === this.lastSyncedSeconds) return;
      this.lastSyncedSeconds = incoming;
      this.digits.set(this.toDigits(incoming));
    }, { allowSignalWrites: true });
  }

  protected boxInvalid(pair: Pair): boolean {
    const p = this.parsed();
    if (pair === 'm') return p.minutesInvalid;
    if (pair === 's') return p.secondsInvalid;
    return false;
  }

  protected onFocus(event: FocusEvent): void {
    // Select so a stray digit typed into a filled box replaces rather than blocks.
    (event.target as HTMLInputElement).select();
  }

  protected onInput(event: Event, index: number): void {
    const el = event.target as HTMLInputElement;
    const ds = el.value.replace(/\D/g, '');
    if (ds === '') {
      // Non-digit (or emptied via IME): reject and restore the box.
      el.value = this.digits()[index];
      return;
    }
    // Distribute the entered digit(s) left-to-right from this box (covers the
    // single-key case and a multi-digit autofill landing in one box).
    const next = [...this.digits()];
    let i = index;
    for (const ch of ds) {
      if (i > 5) break;
      next[i] = ch;
      i++;
    }
    this.digits.set(next);
    el.value = next[index];
    this.focusBox(i);
    this.emit();
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    const key = event.key;

    if (key === 'Backspace') {
      event.preventDefault();
      const next = [...this.digits()];
      if (next[index] !== '') {
        next[index] = '';
        this.digits.set(next);
      } else if (index > 0) {
        next[index - 1] = '';
        this.digits.set(next);
        this.focusBox(index - 1);
      }
      this.emit();
      return;
    }

    if (key === 'Delete') {
      event.preventDefault();
      if (this.digits()[index] !== '') {
        const next = [...this.digits()];
        next[index] = '';
        this.digits.set(next);
        this.emit();
      }
      return;
    }

    if (key === 'ArrowLeft') {
      event.preventDefault();
      this.focusBox(index - 1);
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      this.focusBox(index + 1);
      return;
    }

    if (key === 'Home') {
      event.preventDefault();
      this.focusBox(0);
      return;
    }

    if (key === 'End') {
      event.preventDefault();
      this.focusBox(5);
      return;
    }

    // Block non-digit printable keys. Digits fall through to the input event;
    // shortcut combos (paste/select-all) and navigation keys pass through.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !/[0-9]/.test(key)) {
      event.preventDefault();
    }
  }

  protected onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text') ?? '';
    const ds = text.replace(/\D/g, '');
    if (ds === '') return;
    // Right-align the last six digits: "90" → __:__:90, "2345" → __:23:45.
    const last6 = ds.slice(-6);
    const next = [...EMPTY];
    const offset = 6 - last6.length;
    for (let i = 0; i < last6.length; i++) {
      next[offset + i] = last6[i];
    }
    this.digits.set(next);
    this.focusBox(5);
    this.emit();
  }

  private emit(): void {
    const p = this.parsed();
    this.lastSyncedSeconds = this.norm(p.value);
    this.secondsChange.emit(p.value);
    this.invalid.emit(p.invalid);
  }

  private focusBox(index: number): void {
    const clamped = Math.max(0, Math.min(5, index));
    this.boxEls()[clamped]?.nativeElement.focus();
  }

  private evaluate(digits: readonly string[]): Evaluated {
    const at = (i: number): number => (digits[i] === '' ? 0 : Number(digits[i]));
    const h = at(0) * 10 + at(1);
    const m = at(2) * 10 + at(3);
    const s = at(4) * 10 + at(5);
    const allEmpty = digits.every(d => d === '');
    // A pair is only judged once both of its digits are present ("when the pair
    // completes") — a lone tens digit mid-entry is never flagged.
    const minutesInvalid = digits[2] !== '' && digits[3] !== '' && m > 59;
    const secondsInvalid = digits[4] !== '' && digits[5] !== '' && s > 59;
    return {
      value: allEmpty ? null : h * 3600 + m * 60 + s,
      minutesInvalid,
      secondsInvalid,
      invalid: minutesInvalid || secondsInvalid,
    };
  }

  private toDigits(total: number | null): string[] {
    if (total == null) return [...EMPTY];
    const s = Math.max(0, Math.floor(total));
    const h = Math.min(99, Math.floor(s / 3600));
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const hh = pad(h);
    const mm = pad(m);
    const ss = pad(sec);
    return [hh[0], hh[1], mm[0], mm[1], ss[0], ss[1]];
  }

  /** Normalize a value for the sync guard: 0/null/negative all read as "empty". */
  private norm(v: number | null): number | null {
    return v == null || v <= 0 ? null : Math.floor(v);
  }
}
