import { Component, Input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FileNode, ContextMenuAction, ContextMenuPosition } from '../../models/file.model';
import { ContextMenuComponent } from '../context-menu/context-menu.component';

@Component({
  selector: 'app-file-browser',
  standalone: true,
  imports: [CommonModule, ContextMenuComponent],
  templateUrl: './file-browser.component.html',
  styleUrls: ['./file-browser.component.scss']
})
export class FileBrowserComponent {
  @Input() set files(value: FileNode[]) {
    this.fileTree.set(value);
  }

  fileTree = signal<FileNode[]>([]);
  selectedFiles = signal<Set<string>>(new Set());
  contextMenuVisible = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuNode = signal<FileNode | null>(null);

  selectedCount = computed(() => this.selectedFiles().size);

  contextMenuActions: ContextMenuAction[] = [
    { label: 'Open', icon: '📂', action: 'open' },
    { label: 'Rename', icon: '✏️', action: 'rename' },
    { label: 'Copy', icon: '📋', action: 'copy' },
    { label: 'Cut', icon: '✂️', action: 'cut' },
    { label: 'Delete', icon: '🗑️', action: 'delete', divider: true },
    { label: 'Properties', icon: 'ℹ️', action: 'properties' }
  ];

  getFileIcon(node: FileNode): string {
    if (node.icon) return node.icon;

    if (node.type === 'folder') {
      return node.expanded ? '📂' : '📁';
    }

    // File type icons based on extension
    const ext = node.extension?.toLowerCase();
    const iconMap: { [key: string]: string } = {
      'ts': '🔷',
      'js': '🟨',
      'html': '🌐',
      'css': '🎨',
      'scss': '💅',
      'json': '📋',
      'md': '📝',
      'png': '🖼️',
      'jpg': '🖼️',
      'jpeg': '🖼️',
      'gif': '🖼️',
      'svg': '🎭',
      'pdf': '📄',
      'zip': '📦',
      'txt': '📃'
    };

    return iconMap[ext || ''] || '📄';
  }

  toggleFolder(node: FileNode, event: Event) {
    event.stopPropagation();
    node.expanded = !node.expanded;
    this.fileTree.set([...this.fileTree()]);
  }

  selectFile(node: FileNode, event: MouseEvent) {
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      // Multi-select with Ctrl/Cmd
      const selected = new Set(this.selectedFiles());
      if (selected.has(node.id)) {
        selected.delete(node.id);
      } else {
        selected.add(node.id);
      }
      this.selectedFiles.set(selected);
    } else {
      // Single select
      this.selectedFiles.set(new Set([node.id]));
    }
  }

  isSelected(node: FileNode): boolean {
    return this.selectedFiles().has(node.id);
  }

  onContextMenu(node: FileNode, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    // Select the right-clicked item if not already selected
    if (!this.isSelected(node)) {
      this.selectedFiles.set(new Set([node.id]));
    }

    this.contextMenuNode.set(node);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuVisible.set(true);
  }

  onContextMenuAction(action: string) {
    const node = this.contextMenuNode();
    if (!node) return;

    console.log(`Action: ${action} on`, node.name);

    switch (action) {
      case 'open':
        if (node.type === 'folder') {
          node.expanded = !node.expanded;
          this.fileTree.set([...this.fileTree()]);
        } else {
          console.log('Opening file:', node.name);
        }
        break;
      case 'rename':
        console.log('Rename:', node.name);
        break;
      case 'copy':
        console.log('Copy:', node.name);
        break;
      case 'cut':
        console.log('Cut:', node.name);
        break;
      case 'delete':
        console.log('Delete:', node.name);
        break;
      case 'properties':
        console.log('Properties:', node);
        break;
    }
  }

  closeContextMenu() {
    this.contextMenuVisible.set(false);
    this.contextMenuNode.set(null);
  }

  formatFileSize(bytes?: number): string {
    if (!bytes) return '-';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  formatDate(date?: Date): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  clearSelection() {
    this.selectedFiles.set(new Set());
  }
}
