# Universal Badge & Tag System - Usage Guide

Based on the creamsicle template, this system provides **universal CSS classes** that work on ANY HTML element - `<span>`, `<div>`, `<mat-chip>`, etc.

---

## 1. Badges - Small Compact Indicators

Small badges with **solid colored backgrounds** and **12px border-radius**. Perfect for status indicators, levels, and types.

### Basic Usage
```html
<!-- Works on ANY element -->
<span class="badge level-1">Level 1</span>
<div class="badge status-active">Active</div>
<mat-chip class="badge type-religious">Religious</mat-chip>
```

### Level Badges (1-5 Control Levels)
```html
<span class="badge level-1">Level 1 - Low Control</span>
<span class="badge level-2">Level 2 - Mild Control</span>
<span class="badge level-3">Level 3 - Moderate Control</span>
<span class="badge level-4">Level 4 - High Control</span>
<span class="badge level-5">Level 5 - Extreme Control</span>
```

**Colors:**
- `level-1`: Green (#dcfce7 bg, #16a34a text)
- `level-2`: Light Green (#ecfdf5 bg, #65a30d text)
- `level-3`: Amber (#fef3c7 bg, #d97706 text)
- `level-4`: Red (#fee2e2 bg, #dc2626 text)
- `level-5`: Dark Red (#fca5a5 bg, #991b1b text)

### Type Badges (Organization Types)
```html
<span class="badge type-religious">Religious Movement</span>
<span class="badge type-philosophical">Philosophical Group</span>
<span class="badge type-therapy">Therapy Organization</span>
<span class="badge type-business">Business/MLM</span>
<span class="badge type-political">Political Movement</span>
```

**Colors:**
- `type-religious`: Blue (#dbeafe bg, #2563eb text)
- `type-philosophical`: Purple (#f3e8ff bg, #9333ea text)
- `type-therapy`: Green (#ecfdf5 bg, #059669 text)
- `type-business`: Amber (#fef3c7 bg, #d97706 text)
- `type-political`: Red (#fee2e2 bg, #dc2626 text)

### Status Badges
```html
<span class="badge status-active">Active</span>
<span class="badge status-defunct">Defunct</span>
<span class="badge status-reformed">Reformed</span>
<span class="badge status-investigating">Under Investigation</span>
<span class="badge status-verified">Verified</span>
```

**Colors:**
- `status-active`: Green (#dcfce7 bg, #16a34a text)
- `status-defunct`: Gray (#f3f4f6 bg, #6b7280 text)
- `status-reformed`: Blue (#dbeafe bg, #2563eb text)
- `status-investigating`: Amber (#fef3c7 bg, #d97706 text)
- `status-verified`: Light Blue (#f0f9ff bg, #0369a1 text)

---

## 2. Tags - Larger Pills

Large pill-shaped tags with **20px border-radius** and **semi-transparent rgba backgrounds** (10% opacity). Perfect for categories, warnings, and prominent labels.

### Basic Tag Variants
```html
<!-- Works on ANY element -->
<span class="tag warning">Isolation</span>
<div class="tag success">Transparency</div>
<mat-chip class="tag info">Information</mat-chip>
<span class="tag primary">Featured</span>
```

**Styling:**
- `tag warning`: rgba(239, 68, 68, 0.1) background, #dc2626 text
- `tag success`: rgba(34, 197, 94, 0.1) background, #16a34a text
- `tag info`: rgba(59, 130, 246, 0.1) background, #2563eb text
- `tag primary`: rgba(255, 107, 53, 0.1) background, orange text

### Tag Sizes
Combine with size classes for different emphasis levels:

```html
<!-- Large tag (1rem font, 0.75/1.25rem padding) -->
<span class="tag warning large">Isolation</span>
<span class="tag success large">Transparency</span>

<!-- Medium tag (0.9rem font, 0.6/1.1rem padding) - default when no size specified -->
<span class="tag warning medium">Information Control</span>
<span class="tag success medium">Open Discussion</span>

<!-- Small tag (0.8rem font, 0.4/0.9rem padding) -->
<span class="tag warning small">Fear Tactics</span>
<span class="tag success small">Financial Accountability</span>
```

---

## Complete Examples

### Tag Cloud (Warning Signs)
```html
<div class="tag-cloud">
  <span class="tag warning large">Isolation</span>
  <span class="tag warning medium">Information Control</span>
  <span class="tag warning small">Financial Demands</span>
  <span class="tag warning large">Authoritarianism</span>
  <span class="tag warning medium">Shunning</span>
  <span class="tag warning small">Thought Stopping</span>
</div>
```

### Tag Cloud (Healthy Indicators)
```html
<div class="tag-cloud">
  <span class="tag success large">Transparency</span>
  <span class="tag success medium">Open Discussion</span>
  <span class="tag success small">Voluntary Participation</span>
  <span class="tag success large">Democratic Process</span>
  <span class="tag success medium">Member Autonomy</span>
</div>
```

### Badges Row (Organization Info)
```html
<div class="badge-row">
  <span class="badge status-active">Active</span>
  <span class="badge type-religious">Religious Movement</span>
  <span class="badge level-3">Level 3 - Moderate Control</span>
</div>
```

### With Angular Material Chips
```html
<mat-chip-set>
  <!-- Badges work on mat-chips too -->
  <mat-chip class="badge level-1">Low Control</mat-chip>
  <mat-chip class="badge level-2">Mild Control</mat-chip>
  <mat-chip class="badge level-3">Moderate Control</mat-chip>

  <!-- Tags work on mat-chips too -->
  <mat-chip class="tag warning large">Warning</mat-chip>
  <mat-chip class="tag success">Success</mat-chip>
</mat-chip-set>
```

---

## Dark Mode Support

All badges and tags automatically adjust for dark mode when `body[data-theme="dark"]` or `body.dark-theme` is set. The colors remain the same for consistency.

---

## Styling Details

### Badge Styling
```scss
.badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  margin: 0.25rem;
  cursor: pointer;
  border: none;
}
```

### Tag Styling
```scss
.tag {
  padding: 0.5rem 1rem;
  border-radius: 20px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  white-space: nowrap;
  margin: 0.25rem;

  &:hover {
    background: [slightly darker]; /* 20% opacity on hover */
    transform: translateY(-1px);
  }
}
```

---

## Angular Material Chips (Default)

When using `<mat-chip>` WITHOUT `.badge` or `.tag` classes, you get the default Material chip styling:

```html
<!-- Default Material chip (8px radius, neutral styling) -->
<mat-chip>Default Chip</mat-chip>

<!-- Selected state (orange background) -->
<mat-chip class="mat-mdc-chip-selected">Selected</mat-chip>

<!-- Legacy variants (still supported) -->
<mat-chip class="success">Success</mat-chip>
<mat-chip class="warning">Warning</mat-chip>
<mat-chip class="danger">Danger</mat-chip>
<mat-chip class="info">Info</mat-chip>
```

---

## Summary

| Type | Element | Border Radius | Font Size | Background | Use Case |
|------|---------|--------------|-----------|------------|----------|
| **Badge** | Any (`<span>`, `<div>`, `<mat-chip>`) | 12px | 0.75rem | Solid colors | Status, levels, types |
| **Tag** | Any (`<span>`, `<div>`, `<mat-chip>`) | 20px | 0.8-1rem | rgba (10% opacity) | Warnings, categories |
| **Default Chip** | `<mat-chip>` | 8px | 0.875rem | Neutral bg | General purpose |

### Quick Reference

```html
<!-- BADGES (compact, solid colors) -->
<span class="badge level-1">Level 1</span>
<span class="badge type-religious">Religious</span>
<span class="badge status-active">Active</span>

<!-- TAGS (pills, semi-transparent) -->
<span class="tag warning large">Warning</span>
<span class="tag success medium">Success</span>
<span class="tag info small">Info</span>

<!-- DEFAULT MAT-CHIPS -->
<mat-chip>Standard Chip</mat-chip>
<mat-chip class="success">Success Chip</mat-chip>
```

**Key Points:**
- ✅ Universal - works on ANY HTML element
- ✅ Angular Material compatible
- ✅ Exact creamsicle template styling
- ✅ Dark mode support built-in
- ✅ Hover effects included
- ✅ No hardcoded CSS - all uses CSS variables where appropriate
