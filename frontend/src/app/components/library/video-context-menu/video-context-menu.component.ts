import { Component, Input, Output, EventEmitter, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';

export interface VideoContextMenuAction {
  action: string;
  video?: any;
}

@Component({
  selector: 'app-video-context-menu',
  standalone: true,
  imports: [
    CommonModule,
    MatMenuModule,
    MatIconModule,
    MatDividerModule
  ],
  template: `
    <div style="visibility: hidden; position: fixed;"
         [style.left.px]="position.x"
         [style.top.px]="position.y"
         [matMenuTriggerFor]="contextMenu"
         #menuTrigger="matMenuTrigger">
    </div>

    <mat-menu #contextMenu="matMenu">
      <ng-container *ngIf="video">
        <!-- Single video actions -->
        <button mat-menu-item
                (click)="onAction('rename')"
                *ngIf="selectedCount === 1">
          <mat-icon>edit</mat-icon>
          <span>Rename</span>
        </button>

        <button mat-menu-item
                (click)="onAction('openEditor')"
                *ngIf="selectedCount === 1 && canAnalyze">
          <mat-icon>play_arrow</mat-icon>
          <span>Open in Video Editor</span>
        </button>

        <button mat-menu-item
                (click)="onAction('viewDetails')"
                *ngIf="selectedCount === 1">
          <mat-icon>info</mat-icon>
          <span>View Details</span>
        </button>

        <button mat-menu-item
                (click)="onAction('copyFilename')"
                *ngIf="selectedCount === 1">
          <mat-icon>content_copy</mat-icon>
          <span>Copy Filename</span>
        </button>

        <button mat-menu-item
                (click)="onAction('openLocation')"
                *ngIf="selectedCount === 1">
          <mat-icon>folder_open</mat-icon>
          <span>Open File Location</span>
        </button>

        <!-- Edit Suggested Title -->
        <button mat-menu-item
                (click)="onAction('editSuggestedTitle')"
                *ngIf="selectedCount === 1 && hasSuggestedTitle">
          <mat-icon>auto_awesome</mat-icon>
          <span>Edit Suggested Title</span>
        </button>

        <mat-divider></mat-divider>

        <!-- Add to Tab -->
        <button mat-menu-item (click)="onAction('addToTab')">
          <mat-icon>tab</mat-icon>
          <span>Add to Tab{{ selectedCount > 1 ? ' (' + selectedCount + ')' : '' }}</span>
        </button>

        <mat-divider></mat-divider>

        <!-- Analysis actions -->
        <button mat-menu-item (click)="onAction('analyze')">
          <mat-icon>psychology</mat-icon>
          <span>Run Analysis{{ selectedCount > 1 ? ' (' + selectedCount + ')' : '' }}</span>
        </button>

        <button mat-menu-item (click)="onAction('moveToLibrary')">
          <mat-icon>drive_file_move</mat-icon>
          <span>Move to...{{ selectedCount > 1 ? ' (' + selectedCount + ')' : '' }}</span>
        </button>

        <mat-divider></mat-divider>

        <button mat-menu-item (click)="onAction('delete')">
          <mat-icon color="warn">delete</mat-icon>
          <span>Delete{{ selectedCount > 1 ? ' (' + selectedCount + ')' : '' }}</span>
        </button>
      </ng-container>
    </mat-menu>
  `,
  styles: []
})
export class VideoContextMenuComponent {
  @Input() video: any = null;
  @Input() position = { x: 0, y: 0 };
  @Input() selectedCount = 1;
  @Input() canAnalyze = true;
  @Input() hasSuggestedTitle = false;

  @Output() menuAction = new EventEmitter<VideoContextMenuAction>();

  @ViewChild('menuTrigger', { read: MatMenuTrigger }) menuTrigger?: MatMenuTrigger;

  onAction(action: string) {
    this.menuAction.emit({ action, video: this.video });
  }
}
