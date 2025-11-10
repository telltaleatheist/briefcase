import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AiSetupWizardComponent } from '../ai-setup-wizard/ai-setup-wizard.component';

@Component({
  selector: 'app-first-time-welcome',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './first-time-welcome.component.html',
  styleUrl: './first-time-welcome.component.scss'
})
export class FirstTimeWelcomeComponent {
  constructor(
    private dialogRef: MatDialogRef<FirstTimeWelcomeComponent>,
    private dialog: MatDialog
  ) {}

  close(): void {
    this.dialogRef.close({ completed: true });
  }

  openAISetup(): void {
    // Close this dialog first
    this.dialogRef.close({ openAISetup: true });

    // Open AI setup wizard
    this.dialog.open(AiSetupWizardComponent, {
      width: '900px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      disableClose: false,
      data: { forceSetup: false }
    });
  }

  skipForNow(): void {
    this.dialogRef.close({ skipped: true });
  }
}
