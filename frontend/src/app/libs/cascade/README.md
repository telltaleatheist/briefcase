# 🌊 Cascade

A powerful Angular list component with hierarchical child items, progress tracking, and advanced selection management.

## Features

✅ **Hierarchical Items** - Parent items with expandable children (ghost items)
✅ **Progress Tracking** - Individual and master progress bars
✅ **Advanced Selection** - Multi-select with Cmd/Shift, powered by Angular CDK
✅ **Keyboard Navigation** - Full keyboard support (arrows, space, cmd+a, delete)
✅ **Type-ahead Search** - Instantly find items by typing
✅ **Grouped Lists** - Organize items into collapsible groups
✅ **Context Menus** - Right-click actions with custom menus
✅ **Status Indicators** - Visual status dots with tooltips
✅ **Fully Typed** - Complete TypeScript support
✅ **Accessible** - ARIA labels and keyboard support

## Installation

```bash
npm install @clippy/cascade
```

## Quick Start

```typescript
import { CascadeModule } from '@clippy/cascade';

@NgModule({
  imports: [CascadeModule]
})
export class AppModule { }
```

```html
<cascade-list
  [items]="items"
  [config]="cascadeConfig"
  [selectionMode]="'multiple'"
  (itemClick)="onItemClick($event)">
</cascade-list>
```

## Usage Examples

### Basic List

```typescript
interface MyItem extends CascadeItem {
  title: string;
  date: Date;
}

cascadeConfig: CascadeConfig = {
  primaryField: 'title',
  secondaryField: 'date',
  iconField: 'icon'
};
```

### List with Children & Progress

```typescript
cascadeConfig: CascadeConfig = {
  primaryField: 'filename',

  children: {
    enabled: true,
    expandable: true,
    defaultExpanded: false,
    showMasterProgress: true,

    generator: (item) => [
      {
        id: `${item.id}-step1`,
        parentId: item.id,
        label: 'Transcribe',
        icon: 'mic',
        progress: { value: item.step1Progress },
        status: 'active'
      },
      {
        id: `${item.id}-step2`,
        parentId: item.id,
        label: 'Analyze',
        icon: 'psychology',
        progress: { value: item.step2Progress },
        status: 'pending'
      }
    ],

    masterProgressCalculator: (item) => {
      return (item.step1Progress + item.step2Progress) / 2;
    }
  }
};
```

## API Documentation

See [API.md](./API.md) for complete API documentation.

## License

MIT © Clippy Team
