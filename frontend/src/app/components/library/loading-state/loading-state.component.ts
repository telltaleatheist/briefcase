import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-loading-state',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule],
  template: `
    <div class="loading-container">
      <mat-spinner></mat-spinner>
      <p>{{ message }}</p>
    </div>
  `,
  styleUrl: './loading-state.component.scss'
})
export class LoadingStateComponent {
  @Input() message = 'Loading...';
}
