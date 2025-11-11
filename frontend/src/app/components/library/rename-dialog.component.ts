import { Component, Inject, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';

export interface RenameDialogData {
  filename: string;
  videoId: string;
}

export interface RenameDialogResult {
  renamed: boolean;
  date?: string;
  title?: string;
  extension?: string;
}

@Component({
  selector: 'app-rename-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
  ],
  templateUrl: './rename-dialog.component.html',
  styleUrls: ['./rename-dialog.component.scss']
})
export class RenameDialogComponent implements OnInit, AfterViewInit {
  @ViewChild('titleInput') titleInput?: ElementRef<HTMLInputElement>;

  date: string = '';
  title: string = '';
  extension: string = '';
  originalFilename: string = '';

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: RenameDialogData,
    private dialogRef: MatDialogRef<RenameDialogComponent>
  ) {}

  ngOnInit() {
    this.originalFilename = this.data.filename;
    this.parseFilename(this.data.filename);
  }

  ngAfterViewInit() {
    // Auto-focus the title input and select all text
    setTimeout(() => {
      if (this.titleInput) {
        this.titleInput.nativeElement.focus();
        this.titleInput.nativeElement.select();
      }
    }, 100);
  }

  parseFilename(filename: string) {
    // Remove extension first
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex > 0) {
      this.extension = filename.substring(lastDotIndex + 1);
      filename = filename.substring(0, lastDotIndex);
    }

    // Check if filename starts with date pattern (YYYY-MM-DD)
    const datePattern = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/;
    const match = filename.match(datePattern);

    if (match) {
      this.date = match[1];
      this.title = match[2];
    } else {
      this.date = '';
      this.title = filename;
    }
  }

  getPreviewFilename(): string {
    let filename = '';

    if (this.date && this.date.trim()) {
      filename = `${this.date.trim()} `;
    }

    filename += this.title.trim();

    if (this.extension && this.extension.trim()) {
      filename += `.${this.extension.trim()}`;
    }

    return filename || 'untitled';
  }

  isValid(): boolean {
    return this.title.trim().length > 0;
  }

  save() {
    if (!this.isValid()) {
      return;
    }

    this.dialogRef.close({
      renamed: true,
      date: this.date.trim(),
      title: this.title.trim(),
      extension: this.extension.trim()
    });
  }

  cancel() {
    this.dialogRef.close({ renamed: false });
  }

  handleEnter(event: KeyboardEvent) {
    if (this.isValid()) {
      this.save();
    }
  }
}
