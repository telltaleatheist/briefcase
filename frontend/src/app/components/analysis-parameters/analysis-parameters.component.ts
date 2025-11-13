// clippy/frontend/src/app/components/analysis-parameters/analysis-parameters.component.ts
import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatExpansionModule } from '@angular/material/expansion';

import { AnalysisParametersService, AnalysisCategory } from '../../services/analysis-parameters.service';

@Component({
  selector: 'app-analysis-parameters',
  standalone: true,
  templateUrl: './analysis-parameters.component.html',
  styleUrls: ['./analysis-parameters.component.scss'],
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatExpansionModule
  ]
})
export class AnalysisParametersComponent implements OnInit {
  private fb = inject(FormBuilder);
  private analysisParametersService = inject(AnalysisParametersService);
  private snackBar = inject(MatSnackBar);

  categoriesForm: FormGroup;
  isLoading = false;
  isSaving = false;

  constructor() {
    this.categoriesForm = this.fb.group({
      categories: this.fb.array([])
    });
  }

  ngOnInit(): void {
    this.loadCategories();
  }

  get categories(): FormArray {
    return this.categoriesForm.get('categories') as FormArray;
  }

  loadCategories(): void {
    this.isLoading = true;
    this.analysisParametersService.getCategories().subscribe({
      next: (categories) => {
        this.categories.clear();
        categories.forEach(category => {
          this.categories.push(this.createCategoryFormGroup(category));
        });
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error loading categories:', error);
        this.snackBar.open('Failed to load categories', 'Close', { duration: 3000 });
        this.isLoading = false;
      }
    });
  }

  createCategoryFormGroup(category?: AnalysisCategory): FormGroup {
    return this.fb.group({
      name: [category?.name || '', [Validators.required, Validators.pattern(/^[a-z0-9-]+$/)]],
      description: [category?.description || '', Validators.required]
    });
  }

  addCategory(): void {
    this.categories.push(this.createCategoryFormGroup());
  }

  removeCategory(index: number): void {
    this.categories.removeAt(index);
  }

  moveUp(index: number): void {
    if (index > 0) {
      const category = this.categories.at(index);
      this.categories.removeAt(index);
      this.categories.insert(index - 1, category);
    }
  }

  moveDown(index: number): void {
    if (index < this.categories.length - 1) {
      const category = this.categories.at(index);
      this.categories.removeAt(index);
      this.categories.insert(index + 1, category);
    }
  }

  saveCategories(): void {
    if (this.categoriesForm.invalid) {
      this.snackBar.open('Please fix validation errors', 'Close', { duration: 3000 });
      return;
    }

    this.isSaving = true;
    const categories: AnalysisCategory[] = this.categories.value;

    this.analysisParametersService.saveCategories(categories).subscribe({
      next: () => {
        this.snackBar.open('Categories saved successfully', 'Close', { duration: 3000 });
        this.isSaving = false;
      },
      error: (error) => {
        console.error('Error saving categories:', error);
        this.snackBar.open('Failed to save categories', 'Close', { duration: 3000 });
        this.isSaving = false;
      }
    });
  }

  resetToDefaults(): void {
    if (confirm('Are you sure you want to reset to default categories? This will overwrite your current configuration.')) {
      this.isLoading = true;
      this.analysisParametersService.resetToDefaults().subscribe({
        next: (categories) => {
          this.categories.clear();
          categories.forEach(category => {
            this.categories.push(this.createCategoryFormGroup(category));
          });
          this.snackBar.open('Reset to default categories', 'Close', { duration: 3000 });
          this.isLoading = false;
        },
        error: (error) => {
          console.error('Error resetting categories:', error);
          this.snackBar.open('Failed to reset categories', 'Close', { duration: 3000 });
          this.isLoading = false;
        }
      });
    }
  }
}
