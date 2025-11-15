import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DatabaseMigrationService, MigrationStatus } from '../../services/database-migration.service';

@Component({
  selector: 'app-database-migration-status',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <mat-card class="migration-status-card">
      <mat-card-header>
        <mat-icon mat-card-avatar>sync_alt</mat-icon>
        <mat-card-title>Database Sharing</mat-card-title>
        <mat-card-subtitle>Multi-computer library access</mat-card-subtitle>
      </mat-card-header>

      <mat-card-content>
        <div *ngIf="loading" class="loading">
          <mat-spinner diameter="40"></mat-spinner>
          <p>Loading status...</p>
        </div>

        <div *ngIf="!loading && status" class="status-content">
          <!-- Configured and Shared -->
          <div *ngIf="status.isConfigured && status.isSharedMode" class="status-card success">
            <mat-icon>check_circle</mat-icon>
            <div>
              <h3>Shared Mode Active</h3>
              <p>Database is shared across multiple computers</p>
              <div class="config-details" *ngIf="status.config">
                <p><strong>Computer:</strong> {{ status.config.computerName }}</p>
                <p><strong>NAS Root:</strong> <code>{{ status.config.nasRoot }}</code></p>
              </div>
            </div>
          </div>

          <!-- Configured but not shared -->
          <div *ngIf="status.isConfigured && !status.isSharedMode" class="status-card warning">
            <mat-icon>warning</mat-icon>
            <div>
              <h3>Configuration Found</h3>
              <p>Path mapping configured but shared mode not active</p>
            </div>
          </div>

          <!-- Not configured -->
          <div *ngIf="!status.isConfigured" class="status-card info">
            <mat-icon>info</mat-icon>
            <div>
              <h3>Not Configured</h3>
              <p>Enable database sharing to sync your library across multiple computers</p>
              <ul class="benefits">
                <li>Access same library from Mac, Windows, and Linux</li>
                <li>Automatic synchronization of changes</li>
                <li>Handles different file paths on each computer</li>
              </ul>
            </div>
          </div>
        </div>
      </mat-card-content>

      <mat-card-actions>
        <button mat-raised-button color="primary" (click)="openMigrationWizard()">
          <mat-icon>{{ status?.isConfigured ? 'settings' : 'play_arrow' }}</mat-icon>
          {{ status?.isConfigured ? 'Manage Migration' : 'Setup Database Sharing' }}
        </button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: [`
    .migration-status-card {
      margin: 16px 0;
      max-width: 800px;
    }

    mat-card-header {
      margin-bottom: 16px;
    }

    mat-icon[mat-card-avatar] {
      font-size: 40px;
      width: 40px;
      height: 40px;
      background: transparent;
      color: #2196f3;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;

      p {
        margin-top: 12px;
        color: rgba(255, 255, 255, 0.7);
      }
    }

    .status-content {
      padding: 8px 0;
    }

    .status-card {
      display: flex;
      gap: 16px;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;

      > mat-icon {
        flex-shrink: 0;
        font-size: 32px;
        width: 32px;
        height: 32px;
      }

      h3 {
        margin: 0 0 8px 0;
        font-size: 16px;
        font-weight: 500;
      }

      p {
        margin: 4px 0;
        opacity: 0.9;
      }

      &.success {
        background: rgba(76, 175, 80, 0.15);
        border: 1px solid rgba(76, 175, 80, 0.4);

        mat-icon {
          color: #81c784;
        }

        h3 {
          color: #81c784;
        }
      }

      &.warning {
        background: rgba(255, 152, 0, 0.15);
        border: 1px solid rgba(255, 152, 0, 0.4);

        mat-icon {
          color: #ffb74d;
        }

        h3 {
          color: #ffb74d;
        }
      }

      &.info {
        background: rgba(33, 150, 243, 0.15);
        border: 1px solid rgba(33, 150, 243, 0.4);

        mat-icon {
          color: #64b5f6;
        }

        h3 {
          color: #64b5f6;
        }
      }
    }

    .config-details {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);

      p {
        margin: 4px 0;
        font-size: 14px;
      }

      code {
        padding: 2px 6px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 3px;
        font-family: 'Monaco', 'Courier New', monospace;
        font-size: 12px;
        color: #64b5f6;
      }
    }

    .benefits {
      margin: 12px 0 0 0;
      padding-left: 20px;

      li {
        margin: 6px 0;
        opacity: 0.8;
      }
    }

    mat-card-actions {
      padding: 8px 16px 16px;
    }
  `]
})
export class DatabaseMigrationStatusComponent implements OnInit {
  status: MigrationStatus | null = null;
  loading = true;

  constructor(
    private migrationService: DatabaseMigrationService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.loadStatus();
  }

  loadStatus(): void {
    this.loading = true;
    this.migrationService.getStatus().subscribe({
      next: (status) => {
        this.status = status;
        this.loading = false;
      },
      error: (err) => {
        console.error('Failed to load migration status:', err);
        this.loading = false;
      }
    });
  }

  openMigrationWizard(): void {
    this.router.navigate(['/database-migration']);
  }
}
