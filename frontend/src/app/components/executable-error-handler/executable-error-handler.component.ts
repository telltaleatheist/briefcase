// frontend/src/app/components/executable-error-handler/executable-error-handler.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConfigService } from '../../services/config.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { ExecutableConfigDialogComponent } from './executable-config-dialog.component';

@Component({
  selector: 'app-executable-error-handler',
  template: '', // No UI needed, this is a service component
  styles: []
})
export class ExecutableErrorHandlerComponent implements OnInit, OnDestroy {
  private subscriptions: Subscription[] = [];
  private dialogOpen = false;

  constructor(
    private configService: ConfigService,
    private snackBar: MatSnackBar,
    private dialog: MatDialog
  ) {}

  ngOnInit(): void {
    // Subscribe to configuration status
    this.subscriptions.push(
      this.configService.configStatus$.subscribe(isValid => {
        if (isValid === false && !this.dialogOpen) {
          this.showConfigurationError();
        }
      })
    );

    // Check configuration on init
    this.configService.checkPathConfiguration().subscribe();
  }

  ngOnDestroy(): void {
    // Clean up subscriptions
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  private showConfigurationError(): void {
    const snackBarRef = this.snackBar.open(
      'Required executables (FFmpeg, FFprobe, yt-dlp) are not configured properly.',
      'Configure Now',
      {
        duration: 10000,
        panelClass: 'error-snackbar'
      }
    );

    snackBarRef.onAction().subscribe(() => {
      this.openConfigDialog();
    });
  }

  private openConfigDialog(): void {
    this.dialogOpen = true;

    const dialogRef = this.dialog.open(ExecutableConfigDialogComponent, {
      width: '500px',
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(result => {
      this.dialogOpen = false;
      
      if (result === 'electron-dialog') {
        // User chose to use Electron's native dialog
        this.configService.showPathConfigDialog().subscribe(success => {
          if (success) {
            this.snackBar.open('Configuration saved successfully!', 'Close', {
              duration: 3000,
              panelClass: 'success-snackbar'
            });
          }
        });
      }
    });
  }
}