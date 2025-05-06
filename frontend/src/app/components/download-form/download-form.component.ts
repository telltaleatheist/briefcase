// clippy/frontend/src/app/components/download-form/download-form.component.ts
import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, Validators } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { QUALITY_OPTIONS, BROWSER_OPTIONS } from './download-form.constants';
import { of } from 'rxjs';
import { CommonModule, DatePipe } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { PathService } from '../../services/path.service';
import { MatSnackBar } from '@angular/material/snack-bar';

@Component({
  selector: 'app-download-form',
  templateUrl: './download-form.component.html',
  styleUrls: ['./download-form.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatCheckboxModule,
    MatExpansionModule,  // Add this for mat-expansion-panel
    // Add any other modules you need
  ]
})
export class DownloadFormComponent implements OnInit {
  downloadForm!: FormGroup;
  isLoading = false;
  advancedOptionsExpanded = false;

  urlInfo: any = null;

  qualityOptions = QUALITY_OPTIONS;
  browserOptions = BROWSER_OPTIONS;
  isElectron = false;
  
  constructor(
    private fb: FormBuilder,
    private apiService: ApiService,
    private pathService: PathService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.downloadForm = this.fb.group({
      url: ['', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
      quality: ['720p'],
      convertToMp4: [true],
      fixAspectRatio: [true],
      useCookies: [false],
      browser: ['auto'],
      outputDir: ['']
    });
    
    this.isElectron = !!(window as any).electron;
  }

  onSubmit(): void {
    if (this.downloadForm.invalid) return;
    this.checkUrlAndDownload();
  }

  private checkUrlAndDownload(): void {
    const urlControl = this.downloadForm.get('url');
    const rawUrl = urlControl?.value || '';  // Provide a default empty string
    const url = rawUrl.replace(/^https:\/\/x\.com/, 'https://twitter.com');
      
    this.isLoading = true;
  
    this.apiService.checkUrl(url).subscribe({
        next: (result) => {
        this.isLoading = false;
  
        if (!result || !result.valid) {
          console.warn('URL is invalid');
          this.urlInfo = null;
          urlControl?.setErrors({ invalidUrl: true });
          return;
        }
  
        this.urlInfo = result.info || null;
        urlControl?.setErrors(null);
  
        this.startDownload();
      },
      error: (err) => {
        this.isLoading = false;
        this.urlInfo = null;
  
        console.error('Error during URL check:', err);
        urlControl?.setErrors({ invalidUrl: true });
      }
    });
  }
  
  startDownload(): void {
    const settings = this.downloadForm.value;
    this.apiService.downloadVideo(settings).subscribe({
      next: (res) => {
        // Optionally update UI state here
      },
      error: (err) => {
        console.error('❌ Failed to start download:', JSON.stringify(err, null, 2));
        // Show error to the user if needed
      }
    });
  }

  pasteFromClipboard(): void {
    navigator.clipboard.readText().then(text => {
      this.downloadForm.get('url')?.setValue(text);
    });
  }

  browseOutputDir(): void {
    if (this.isElectron) {
      this.pathService.openDirectoryPicker().subscribe({
        next: (path) => {
          if (path) {
            this.downloadForm.patchValue({ outputDir: path });
          }
        },
        error: (error) => {
          console.error('Error picking directory:', error);
          this.snackBar.open('Error selecting directory', 'Dismiss', { duration: 3000 });
        }
      });
    } else {
      this.snackBar.open('Directory selection is not available in the web version', 'Dismiss', { duration: 3000 });
    }
  }
}