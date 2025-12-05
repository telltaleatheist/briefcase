import { Component, EventEmitter, Input, Output, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../button/button.component';
import { TabsService, VideoTab } from '../../services/tabs.service';
import { firstValueFrom } from 'rxjs';

export interface AddToTabsResult {
  addToLibrary: boolean;
  addToTabs: boolean;
  tabIds: string[];
  createNewTab?: string; // Name of new tab to create
}

@Component({
  selector: 'app-add-to-tabs-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  templateUrl: './add-to-tabs-dialog.component.html',
  styleUrls: ['./add-to-tabs-dialog.component.scss']
})
export class AddToTabsDialogComponent {
  private tabsService = inject(TabsService);

  @Input() set show(value: boolean) {
    this.visible.set(value);
    if (value) {
      this.loadTabs();
      this.resetForm();
    }
  }

  @Input() set selectedCount(value: number) {
    this._selectedCount.set(value);
  }

  @Output() confirm = new EventEmitter<AddToTabsResult>();
  @Output() closed = new EventEmitter<void>();

  visible = signal(false);
  _selectedCount = signal(0);

  // Options
  addToLibrary = signal(true);
  addToTabs = signal(false);

  // Tabs
  availableTabs = signal<VideoTab[]>([]);
  selectedTabIds = signal<Set<string>>(new Set());

  // New tab creation
  showNewTabInput = signal(false);
  newTabName = signal('');
  maxTabNameLength = 100;

  private async loadTabs() {
    try {
      const tabs = await firstValueFrom(this.tabsService.getAllTabs());
      this.availableTabs.set(tabs);
    } catch (error) {
      console.error('Failed to load tabs:', error);
      this.availableTabs.set([]);
    }
  }

  private resetForm() {
    this.addToLibrary.set(true);
    this.addToTabs.set(false);
    this.selectedTabIds.set(new Set());
    this.showNewTabInput.set(false);
    this.newTabName.set('');
  }

  toggleTab(tabId: string) {
    const selected = new Set(this.selectedTabIds());
    if (selected.has(tabId)) {
      selected.delete(tabId);
    } else {
      selected.add(tabId);
    }
    this.selectedTabIds.set(selected);
  }

  isTabSelected(tabId: string): boolean {
    return this.selectedTabIds().has(tabId);
  }

  toggleNewTabInput() {
    this.showNewTabInput.set(!this.showNewTabInput());
    if (this.showNewTabInput()) {
      // Auto-enable "Add to Tabs" when showing new tab input
      this.addToTabs.set(true);
    }
  }

  onAddToTabsChanged(value: boolean) {
    this.addToTabs.set(value);
    if (!value) {
      // Clear selections when disabling
      this.selectedTabIds.set(new Set());
      this.showNewTabInput.set(false);
      this.newTabName.set('');
    }
  }

  canConfirm(): boolean {
    // Must have at least one action selected
    if (!this.addToLibrary() && !this.addToTabs()) {
      return false;
    }

    // If adding to tabs, must have at least one tab selected or new tab name
    if (this.addToTabs()) {
      const hasTabSelection = this.selectedTabIds().size > 0;
      const hasNewTabName = this.newTabName().trim().length > 0;
      if (!hasTabSelection && !hasNewTabName) {
        return false;
      }
    }

    return true;
  }

  confirm_action() {
    if (!this.canConfirm()) {
      return;
    }

    const result: AddToTabsResult = {
      addToLibrary: this.addToLibrary(),
      addToTabs: this.addToTabs(),
      tabIds: Array.from(this.selectedTabIds()),
      createNewTab: this.newTabName().trim() || undefined
    };

    this.confirm.emit(result);
    this.close();
  }

  close() {
    this.visible.set(false);
    this.closed.emit();
  }

  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }
}
