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

    if (speed < 0) {
      // Backwards playback - simulate by jumping backwards repeatedly
      const absSpeed = Math.abs(speed);
      this.player.pause();
      // Jump back proportional to speed (1x = 0.5s, 2x = 1s, 4x = 2s, 8x = 4s)
      const jumpAmount = 0.5 * absSpeed;
      const currentTime = this.player.currentTime();
      if (currentTime !== undefined) {
        this.player.currentTime(Math.max(0, currentTime - jumpAmount));
      }
      this.updateState({ isPlaying: false, playbackRate: speed });
    } else if (speed === 0) {
      // Pause (K key)
      this.player.pause();
      this.player.playbackRate(1);
      this.updateState({ isPlaying: false, playbackRate: 1 });
    } else {
      // Forward playback at specified speed (L key)
      this.player.playbackRate(speed);
      if (this.player.paused()) {
        this.player.play();
      }
      this.updateState({ isPlaying: true, playbackRate: speed });
    }
  }

  /**
   * J/K/L key handling (Final Cut Pro style)
   */
  handleJKLKey(key: 'j' | 'k' | 'l'): void {
    if (!this.player) return;

    const currentSpeed = this.currentState.playbackRate;

    switch (key) {
      case 'k': // Pause
        this.lastKeyPressed = 'k';
        this.setPlaybackSpeed(0);
        break;

      case 'j': // Rewind (increase speed each press)
        if (this.lastKeyPressed === 'j' && currentSpeed < 0) {
          // Increase rewind speed: -1 -> -2 -> -4 -> -8
          const newSpeed = Math.max(-8, currentSpeed * 2) as PlaybackSpeed;
          this.setPlaybackSpeed(newSpeed);
        } else {
          // Start rewinding at -1x
          this.setPlaybackSpeed(-1);
        }
        this.lastKeyPressed = 'j';
        break;

      case 'l': // Fast forward (increase speed each press)
        if (this.lastKeyPressed === 'l' && currentSpeed > 0) {
          // Increase forward speed: 1 -> 2 -> 4 -> 8
          const newSpeed = Math.min(8, currentSpeed * 2) as PlaybackSpeed;
          this.setPlaybackSpeed(newSpeed);
        } else {
          // Start playing forward at 1x
          this.setPlaybackSpeed(1);
        }
        this.lastKeyPressed = 'l';
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
