import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { SettingsService } from '../../services/settings.service';

interface ReportFile {
  name: string;
  path: string;
  date: Date;
  size: number;
}

interface ParsedSection {
  timeRange: string;
  category: string;
  description: string;
  quotes: Array<{
    timestamp: string;
    text: string;
    significance: string;
  }>;
}

@Component({
  selector: 'app-analysis-reports',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './analysis-reports.component.html',
  styleUrls: ['./analysis-reports.component.scss']
})
export class AnalysisReportsComponent implements OnInit {
  reports: ReportFile[] = [];
  selectedReport: ReportFile | null = null;
  reportContent: string = '';
  parsedSections: ParsedSection[] = [];
  isLoading = false;
  reportsDirectory = '';

  constructor(
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private settingsService: SettingsService
  ) {}

  async ngOnInit() {
    await this.loadReports();
  }

  async loadReports() {
    try {
      this.isLoading = true;

      // Get the configured output directory from settings
      const settings = this.settingsService.getCurrentSettings();
      const baseOutputDir = settings.outputDir || (await this.getDefaultOutputDir());
      this.reportsDirectory = `${baseOutputDir}/analysis/reports`;

      // Use electron to read directory
      const files = await this.readReportsDirectory();

      this.reports = files
        .filter((f: any) => f.name.endsWith('.txt'))
        .map((f: any) => ({
          name: f.name.replace('.txt', ''),
          path: f.path,
          date: new Date(f.stats.mtime),
          size: f.stats.size
        }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());

    } catch (error: any) {
      console.error('Error loading reports:', error);
      this.snackBar.open('Failed to load reports', 'Dismiss', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  private async getDefaultOutputDir(): Promise<string> {
    try {
      const homeDir = await (window as any).electron?.environment?.getPathConfig?.();
      return `${homeDir?.downloadsPath || '/Users/telltale/Downloads'}/clippy`;
    } catch (error) {
      console.error('Error getting default output dir:', error);
      return '/Users/telltale/Downloads/clippy';
    }
  }

  private async readReportsDirectory(): Promise<any[]> {
    try {
      const response = await fetch('/api/api/analysis/reports');
      if (!response.ok) throw new Error('Failed to fetch reports');
      const data = await response.json();
      return data.reports || [];
    } catch (error) {
      console.error('Error reading reports directory:', error);
      return [];
    }
  }

  async selectReport(report: ReportFile) {
    try {
      this.isLoading = true;
      this.selectedReport = report;

      // Read file content
      this.reportContent = await this.readReportFile(report.path);

      // Parse the content
      this.parsedSections = this.parseReportContent(this.reportContent);

    } catch (error: any) {
      console.error('Error reading report:', error);
      this.snackBar.open('Failed to read report', 'Dismiss', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  private async readReportFile(filePath: string): Promise<string> {
    const response = await fetch(`/api/api/analysis/report/${encodeURIComponent(filePath)}`);
    if (!response.ok) throw new Error('Failed to read file');
    const data = await response.json();
    return data.content || '';
  }

  private parseReportContent(content: string): ParsedSection[] {
    const sections: ParsedSection[] = [];

    // Split by section dividers
    const parts = content.split('---');

    for (const part of parts) {
      if (part.trim().length === 0 || part.includes('VIDEO ANALYSIS RESULTS')) continue;

      const lines = part.trim().split('\n');

      // Parse section header (e.g., "**0:09 - 0:12 - Description [category]**")
      const headerLine = lines.find(l => l.trim().startsWith('**') && l.includes('[') && l.includes(']'));
      if (!headerLine) continue;

      const headerMatch = headerLine.match(/\*\*(.+?)\s+-\s+(.+?)\s+-\s+(.+?)\s+\[(.+?)\]\*\*/);
      if (!headerMatch) continue;

      const section: ParsedSection = {
        timeRange: `${headerMatch[1]} - ${headerMatch[2]}`,
        description: headerMatch[3],
        category: headerMatch[4],
        quotes: []
      };

      // Parse quotes
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Quote line format: "00:09 - "quote text""
        const quoteMatch = line.match(/^(\d+:\d+)\s+-\s+"(.+)"$/);
        if (quoteMatch) {
          const timestamp = quoteMatch[1];
          const text = quoteMatch[2];

          // Next line should be significance (starts with →)
          let significance = '';
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            if (nextLine.startsWith('→')) {
              significance = nextLine.replace('→', '').trim();
            }
          }

          section.quotes.push({
            timestamp,
            text,
            significance
          });
        }
      }

      if (section.quotes.length > 0) {
        sections.push(section);
      }
    }

    return sections;
  }

  getCategoryIcon(category: string): string {
    const icons: {[key: string]: string} = {
      'controversy': 'warning',
      'claim': 'fact_check',
      'argument': 'forum',
      'emotional': 'sentiment_satisfied',
      'insight': 'lightbulb',
      'technical': 'engineering',
      'other': 'more_horiz'
    };
    return icons[category] || 'description';
  }

  getCategoryColor(category: string): string {
    const colors: {[key: string]: string} = {
      'controversy': '#ff5722',
      'claim': '#2196f3',
      'argument': '#9c27b0',
      'emotional': '#ff9800',
      'insight': '#4caf50',
      'technical': '#607d8b',
      'other': '#757575'
    };
    return colors[category] || '#757575';
  }

  async openInEditor(report: ReportFile) {
    try {
      await (window as any).electron?.openFile(report.path);
    } catch (error) {
      this.snackBar.open('Failed to open file', 'Dismiss', { duration: 3000 });
    }
  }

  async showInFolder(report: ReportFile) {
    try {
      await (window as any).electron?.showInFolder(report.path);
    } catch (error) {
      this.snackBar.open('Failed to show file', 'Dismiss', { duration: 3000 });
    }
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
