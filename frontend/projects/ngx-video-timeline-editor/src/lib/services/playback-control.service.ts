import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { PlaybackState, PlaybackSpeed } from '../models';
import Player from 'video.js/dist/types/player';

@Injectable({
  providedIn: 'root'
})
export class PlaybackControlService {
  private playbackState$ = new BehaviorSubject<PlaybackState>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    playbackRate: 1,
    volume: 1,
    muted: false
  });

  private player: Player | null = null;
  private lastKeyPressed: 'j' | 'k' | 'l' | null = null;

  get state(): Observable<PlaybackState> {
    return this.playbackState$.asObservable();
  }

  get currentState(): PlaybackState {
    return this.playbackState$.value;
  }

  /**
   * Set the video.js player instance
   */
  setPlayer(player: Player | null): void {
    this.player = player;

    if (player) {
      // Update state from player
      this.updateStateFromPlayer();
    }
  }

  /**
   * Play
   */
  play(): void {
    if (this.player) {
      this.player.play();
      this.updateState({ isPlaying: true });
    }
  }

  /**
   * Pause
   */
  pause(): void {
    if (this.player) {
      this.player.pause();
      this.updateState({ isPlaying: false, playbackRate: 1 });
    }
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause(): void {
    if (this.currentState.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Seek to time
   */
  seek(time: number): void {
    if (this.player) {
      this.player.currentTime(time);
      this.updateState({ currentTime: time });
    }
  }

  /**
   * Seek relative to current time
   */
  seekRelative(delta: number): void {
    const newTime = Math.max(0, Math.min(this.currentState.duration, this.currentState.currentTime + delta));
    this.seek(newTime);
  }

  /**
   * Set playback speed
   */
  setPlaybackSpeed(speed: PlaybackSpeed): void {
    if (!this.player) return;

    if (speed === 0) {
      // Pause
      this.player.pause();
      this.player.playbackRate(1);
      this.updateState({ isPlaying: false, playbackRate: 1 });
    } else {
      // Play at specified speed
      this.player.playbackRate(speed);
      if (this.player.paused()) {
        this.player.play();
      }
      this.updateState({ isPlaying: true, playbackRate: speed });
    }
  }

  /**
   * J/K/L key handling (Custom style)
   * K: Pause/Play toggle
   * L: Speed up (1x -> 1.5x -> 2x -> 3x -> 4x -> 8x)
   * J: Slow down (1x -> 0.75x -> 0.5x -> 0.25x -> 0.125x)
   */
  handleJKLKey(key: 'j' | 'k' | 'l'): void {
    if (!this.player) return;

    const currentSpeed = this.currentState.playbackRate;
    const isPlaying = this.currentState.isPlaying;

    switch (key) {
      case 'k': // Pause/Play toggle
        this.lastKeyPressed = 'k';
        if (isPlaying) {
          this.pause();
        } else {
          // Reset to 1x speed when resuming from pause
          this.player.playbackRate(1);
          this.play();
        }
        break;

      case 'l': // Speed up
        if (!isPlaying) {
          // Not playing - start playing at 1x
          this.setPlaybackSpeed(1);
        } else if (this.lastKeyPressed === 'l') {
          // Already speeding up - increase speed
          let newSpeed: number;
          if (currentSpeed >= 1 && currentSpeed < 1.5) {
            newSpeed = 1.5;
          } else if (currentSpeed >= 1.5 && currentSpeed < 2) {
            newSpeed = 2;
          } else if (currentSpeed >= 2 && currentSpeed < 3) {
            newSpeed = 3;
          } else if (currentSpeed >= 3 && currentSpeed < 4) {
            newSpeed = 4;
          } else if (currentSpeed >= 4 && currentSpeed < 8) {
            newSpeed = 8;
          } else {
            newSpeed = 8; // Max speed
          }
          this.setPlaybackSpeed(newSpeed as PlaybackSpeed);
        } else {
          // First L press while playing - go to 1.5x
          this.setPlaybackSpeed(1.5);
        }
        this.lastKeyPressed = 'l';
        break;

      case 'j': // Slow down
        if (!isPlaying) {
          // Not playing - start playing at 1x
          this.setPlaybackSpeed(1);
        } else if (this.lastKeyPressed === 'j') {
          // Already slowing down - decrease speed
          let newSpeed: number;
          if (currentSpeed > 0.75 && currentSpeed <= 1) {
            newSpeed = 0.75;
          } else if (currentSpeed > 0.5 && currentSpeed <= 0.75) {
            newSpeed = 0.5;
          } else if (currentSpeed > 0.25 && currentSpeed <= 0.5) {
            newSpeed = 0.25;
          } else if (currentSpeed > 0.125 && currentSpeed <= 0.25) {
            newSpeed = 0.125;
          } else {
            newSpeed = 0.125; // Min speed
          }
          this.setPlaybackSpeed(newSpeed as PlaybackSpeed);
        } else {
          // First J press while playing - go to 0.75x
          this.setPlaybackSpeed(0.75);
        }
        this.lastKeyPressed = 'j';
        break;
    }
  }

  /**
   * Update state from player (call this on timeupdate events)
   */
  updateStateFromPlayer(): void {
    if (!this.player) return;

    const currentTime = this.player.currentTime();
    const duration = this.player.duration();

    if (currentTime !== undefined && duration !== undefined) {
      this.updateState({
        currentTime,
        duration,
        isPlaying: !this.player.paused(),
        playbackRate: this.player.playbackRate() || 1,
        volume: this.player.volume() || 1,
        muted: this.player.muted() || false
      });
    }
  }

  /**
   * Reset state
   */
  reset(): void {
    this.playbackState$.next({
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      playbackRate: 1,
      volume: 1,
      muted: false
    });
    this.lastKeyPressed = null;
  }

  private updateState(partial: Partial<PlaybackState>): void {
    this.playbackState$.next({
      ...this.currentState,
      ...partial
    });
  }
}
