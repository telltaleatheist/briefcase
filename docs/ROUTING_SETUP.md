# Routing Setup Guide

## Problem: New Routes Not Working

When you add a new route/page to the application and it doesn't navigate properly, it's likely because the app uses **two different routing systems** depending on the context.

## Understanding the Dual Routing System

This application uses:
1. **Module-based routing** (`app-routing.module.ts`) - Used by the actual running app
2. **Standalone routing** (`app.routes.ts`) - May exist but is NOT used by the module-based app

### Why This Happens

The app uses `AppModule` (see `main.ts`), which imports `AppRoutingModule`. This means routes must be defined in `app-routing.module.ts`, NOT in `app.routes.ts`.

## How to Add a New Route

### Step 1: Check Which Routing System Is Active

Look at `frontend/src/main.ts`:

```typescript
// If you see this, you're using MODULE-based routing:
platformBrowserDynamic().bootstrapModule(AppModule)

// If you see this, you're using STANDALONE routing:
bootstrapApplication(AppComponent, appConfig)
```

**This app uses MODULE-based routing.**

### Step 2: Add Route to the Correct File

#### ✅ Correct: Add to `app-routing.module.ts`

```typescript
// frontend/src/app/app-routing.module.ts
const routes: Routes = [
  // ... existing routes ...
  {
    path: 'your-new-page',
    loadComponent: () => import('./components/your-component/your-component.component')
      .then(m => m.YourComponent)
  }
];
```

#### ❌ Wrong: Adding ONLY to `app.routes.ts`

```typescript
// This file is NOT used by the module-based app!
export const routes: Routes = [
  { path: 'your-new-page', component: YourComponent }  // Won't work!
];
```

### Step 3: Add Navigation Link in Sidebar

Edit `frontend/src/app/app.component.html`:

```html
<mat-nav-list class="nav-list">
  <!-- Existing links -->

  <a mat-list-item routerLink="/your-new-page" routerLinkActive="active-link">
    <mat-icon matListItemIcon>your_icon</mat-icon>
    <span matListItemTitle>Your Page Title</span>
  </a>
</mat-nav-list>
```

**Important:** Use `routerLink="/path"` (string form), NOT `[routerLink]="['/path']"` (array form) to avoid issues.

### Step 4: Remove Click Handlers

Do NOT add click handlers to navigation links:

```html
<!-- ❌ Wrong -->
<a mat-list-item routerLink="/page" (click)="navigateToPage()">

<!-- ✅ Correct -->
<a mat-list-item routerLink="/page" routerLinkActive="active-link">
```

The `routerLink` directive handles navigation automatically.

## Real Example: Adding Settings Page

### Before (Not Working)

1. Route was only added to `app.routes.ts` ❌
2. Navigation had a click handler: `(click)="navigateToAnalysis()"` ❌

### After (Working)

1. Route added to `app-routing.module.ts`: ✅

```typescript
{
  path: 'settings',
  loadComponent: () => import('./components/settings/settings.component')
    .then(m => m.SettingsComponent)
}
```

2. Navigation link simplified: ✅

```html
<a mat-list-item routerLink="/settings" routerLinkActive="active-link">
  <mat-icon matListItemIcon>settings</mat-icon>
  <span matListItemTitle>Settings</span>
</a>
```

## Troubleshooting

### Route Still Not Working?

1. **Check main.ts** - Verify which routing system is active
2. **Clear build cache** - Run `npm run clean:all` then rebuild
3. **Check browser console** - Look for routing errors
4. **Verify component is standalone** - Component must have `standalone: true`

### Build Output Verification

After building, check the output for your component:

```bash
npm run build:frontend
```

Look for your component in the lazy chunk files:

```
Lazy chunk files      | Names                      |  Raw size
chunk-YDYWYORF.js     | settings-component         |   9.03 kB
```

If you don't see it, the route isn't configured properly.

## Common Mistakes

1. ❌ Adding route to `app.routes.ts` instead of `app-routing.module.ts`
2. ❌ Using `[routerLink]="['/path']"` instead of `routerLink="/path"`
3. ❌ Adding click handlers that interfere with router
4. ❌ Forgetting to make component `standalone: true`
5. ❌ Not rebuilding after route changes

## Quick Checklist

When adding a new route:

- [ ] Add route to `app-routing.module.ts` (NOT `app.routes.ts`)
- [ ] Use lazy loading with `loadComponent`
- [ ] Add navigation link to sidebar
- [ ] Use string form: `routerLink="/path"`
- [ ] Remove any click handlers
- [ ] Rebuild: `npm run build:frontend`
- [ ] Verify component appears in lazy chunk files
- [ ] Test navigation in running app

## Related Files

- `frontend/src/main.ts` - Shows which routing system is active
- `frontend/src/app/app-routing.module.ts` - **ACTIVE** routing file
- `frontend/src/app/app.routes.ts` - Legacy/unused in module-based apps
- `frontend/src/app/app.component.html` - Sidebar navigation
- `frontend/src/app/app.module.ts` - Main module configuration

## History

This guide was created after the Settings page routing issue (2025-10-28), where routes were initially added to the wrong file (`app.routes.ts` instead of `app-routing.module.ts`).
