import { Component } from '@angular/core';
import { VideoPlayerComponent } from '../../components/video-player/video-player.component';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [VideoPlayerComponent],
  template: '<app-video-player />',
  styles: [`
    :host {
      display: block;
      height: 100vh;
      overflow: hidden;
    }
  `]
})
export class EditorComponent {}
