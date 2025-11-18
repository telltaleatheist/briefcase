import { Component } from '@angular/core';
import { VideoEditorComponent } from '../../components/video-editor/video-editor.component';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [VideoEditorComponent],
  template: '<app-video-editor />',
  styles: [`
    :host {
      display: block;
      height: 100vh;
      overflow: hidden;
    }
  `]
})
export class EditorComponent {}
