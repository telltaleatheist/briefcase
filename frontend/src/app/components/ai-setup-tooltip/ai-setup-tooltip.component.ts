import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { trigger, state, style, transition, animate } from '@angular/animations';

export type TooltipType = 'info' | 'warning' | 'success' | 'setup';
export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right' | 'center';

@Component({
  selector: 'app-ai-setup-tooltip',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ai-setup-tooltip.component.html',
  styleUrl: './ai-setup-tooltip.component.scss',
  animations: [
    trigger('popIn', [
      state('void', style({
        transform: 'scale(0.3)',
        opacity: 0
      })),
      state('*', style({
        transform: 'scale(1)',
        opacity: 1
      })),
      transition('void => *', [
        animate('300ms cubic-bezier(0.68, -0.55, 0.265, 1.55)')
      ]),
      transition('* => void', [
        animate('200ms ease-out', style({
          transform: 'scale(0.3)',
          opacity: 0
        }))
      ])
    ]),
    trigger('bounce', [
      transition('* => *', [
        animate('600ms', style({ transform: 'translateY(-10px)' })),
        animate('600ms', style({ transform: 'translateY(0)' }))
      ])
    ])
  ]
})
export class AiSetupTooltipComponent {
  @Input() type: TooltipType = 'info';
  @Input() position: TooltipPosition = 'center';
  @Input() title: string = '';
  @Input() message: string = '';
  @Input() showCloseButton: boolean = true;
  @Input() showActionButton: boolean = false;
  @Input() actionButtonText: string = 'Got it!';
  @Input() secondaryButtonText?: string;
  @Input() icon?: string; // Custom emoji/icon
  @Input() maxWidth: string = '400px';
  @Input() bounce: boolean = false;

  @Output() close = new EventEmitter<void>();
  @Output() action = new EventEmitter<void>();
  @Output() secondaryAction = new EventEmitter<void>();

  get tooltipIcon(): string {
    if (this.icon) return this.icon;

    switch (this.type) {
      case 'info': return '💡';
      case 'warning': return '⚠️';
      case 'success': return '✨';
      case 'setup': return '🤖';
      default: return '💡';
    }
  }

  get tooltipClass(): string {
    return `tooltip-${this.type}`;
  }

  onClose(): void {
    this.close.emit();
  }

  onAction(): void {
    this.action.emit();
  }

  onSecondaryAction(): void {
    this.secondaryAction.emit();
  }
}
