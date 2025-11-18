import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-drop-zone-overlay',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="drop-zone-overlay" [class.show]="isVisible">
      <div class="drop-zone-content">
        <mat-icon>cloud_upload</mat-icon>
        <h2>Drop media files or folders here</h2>
        <p>Choose: Import, Transcribe, or Analyze</p>
        <p class="hint">Folders will be scanned recursively</p>
      </div>
    </div>
  `,
  styleUrl: './drop-zone-overlay.component.scss'
})
export class DropZoneOverlayComponent {
  @Input() isVisible = false;
}
