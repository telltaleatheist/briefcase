# 🍊 Creamsicle Angular Template

A stunning, production-ready Angular application featuring the beautiful Creamsicle design system with smooth animations, perfect light/dark mode support, and a comprehensive component library.

## ✨ Features

- 🎨 **Beautiful Design System** - Warm orange color palette with carefully crafted components
- 🌓 **Light & Dark Mode** - Seamless theme switching with smooth transitions
- ⚡ **Blazing Fast** - Built with Angular 17+ standalone components
- 📱 **Fully Responsive** - Perfect on mobile, tablet, and desktop
- 🧩 **Modular Architecture** - Clean, organized file structure
- ✨ **Smooth Animations** - Delightful micro-interactions throughout
- 🎯 **TypeScript** - Fully typed for better developer experience
- 📦 **Standalone Components** - Modern Angular architecture
- 🛣️ **Lazy Loading** - Optimized bundle sizes with route-based code splitting

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm
- Angular CLI 17+

### Installation

1. Install dependencies:
```bash
cd angular-app
npm install
```

2. Start the development server:
```bash
npm start
```

3. Open your browser to `http://localhost:4200`

## 📁 Project Structure

```
angular-app/
├── src/
│   ├── app/
│   │   ├── components/        # Reusable UI components
│   │   │   ├── button/
│   │   │   └── card/
│   │   ├── core/              # Core components (navigation, etc.)
│   │   │   └── navigation/
│   │   ├── pages/             # Page components
│   │   │   ├── home/
│   │   │   ├── dashboard/
│   │   │   ├── components/
│   │   │   └── gallery/
│   │   ├── services/          # Angular services
│   │   │   └── theme.service.ts
│   │   ├── app.component.ts
│   │   ├── app.config.ts
│   │   └── app.routes.ts
│   ├── styles/                # Global styles
│   │   ├── _variables.scss    # Design tokens
│   │   ├── _mixins.scss       # Reusable mixins
│   │   ├── _themes.scss       # Light/dark themes
│   │   ├── _reset.scss        # CSS reset
│   │   └── _utilities.scss    # Utility classes
│   ├── index.html
│   ├── main.ts
│   └── styles.scss
├── angular.json
├── package.json
├── tsconfig.json
└── README.md
```

## 🎨 Design System

### Colors

The Creamsicle design system uses a warm, inviting color palette:

- **Primary Orange**: `#ff6b35` - Main brand color
- **Light Orange**: `#ff8c5a` - Lighter variant
- **Dark Orange**: `#e55529` - Darker variant
- **Accent Orange**: `#ffa366` - Accent color

### Typography

- **Font Family**: Inter
- **Weights**: 300, 400, 500, 600, 700, 800, 900
- **Scale**: 0.75rem to 3rem (12px to 48px)

### Spacing

Based on a consistent 4px scale:
- xs: 4px
- sm: 8px
- md: 16px
- lg: 24px
- xl: 32px
- 2xl: 48px
- 3xl: 64px
- 4xl: 96px

## 🧩 Components

### Button Component

```html
<app-button variant="primary" size="md" icon="🚀">
  Click Me
</app-button>
```

**Variants**: primary, secondary, outline, ghost, gradient
**Sizes**: sm, md, lg

### Card Component

```html
<app-card
  title="My Card"
  icon="🎨"
  badge="New"
  badgeClass="badge-success"
  [hoverable]="true"
>
  Card content goes here
</app-card>
```

## 🎯 Pages

1. **Home** - Landing page with hero section and features
2. **Dashboard** - Analytics dashboard with metrics and charts
3. **Components** - Component library showcase
4. **Gallery** - Beautiful grid gallery with filters

## 🌓 Theme System

The theme service provides easy theme switching:

```typescript
import { ThemeService } from './services/theme.service';

constructor(private themeService: ThemeService) {}

toggleTheme() {
  this.themeService.toggleTheme();
}

// Check current theme
this.themeService.currentTheme() // 'light' or 'dark'
this.themeService.isDarkMode() // boolean
```

## 🎨 Custom Styling

All components use CSS custom properties for easy theming:

```scss
@use 'styles/variables' as *;
@use 'styles/mixins' as *;

.my-component {
  background: var(--bg-card);
  color: var(--text-primary);
  border-radius: $radius-lg;
  padding: $spacing-lg;

  @include card-base;
  @include respond-to(md) {
    padding: $spacing-xl;
  }
}
```

## 📦 Build

Create a production build:

```bash
npm run build
```

The build artifacts will be stored in the `dist/` directory.

## 🧪 Testing

Run unit tests:

```bash
npm test
```

## 📝 License

This template is free to use for personal and commercial projects.

## 🎉 Credits

Built with ❤️ using Angular 17+

---

**Enjoy building with Creamsicle!** 🍊✨
