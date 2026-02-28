---
name: tailwind-design-system
description: Build production-ready design systems with Tailwind CSS v4, including CSS-first configuration, design tokens, component variants, and accessibility. Use when working with Tailwind projects.
---

# Tailwind Design System (v4)

Build production-ready design systems with Tailwind CSS v4, including CSS-first configuration, design tokens, component variants, responsive patterns, and accessibility.

> **Note**: This skill targets Tailwind CSS v4 (2024+). For v3 projects, refer to the upgrade guide.

## When to Use This Skill

* Creating a component library with Tailwind v4
* Implementing design tokens and theming with CSS-first configuration
* Building responsive and accessible components
* Standardizing UI patterns across a codebase
* Migrating from Tailwind v3 to v4
* Setting up dark mode with native CSS features

## Key v4 Changes

| v3 Pattern                          | v4 Pattern                                                       |
| ----------------------------------- | ---------------------------------------------------------------- |
| tailwind.config.ts                  | @theme in CSS                                                    |
| @tailwind base/components/utilities | @import "tailwindcss"                                            |
| darkMode: "class"                   | @custom-variant dark (&:where(.dark, .dark \*))                  |
| theme.extend.colors                 | @theme { --color-\*: value }                                     |
| require("tailwindcss-animate")      | CSS @keyframes in @theme + @starting-style for entry animations  |

## Core Concepts

### 1. Design Token Hierarchy

```
Brand Tokens (abstract)
    └── Semantic Tokens (purpose)
        └── Component Tokens (specific)

Example:
    oklch(45% 0.2 260) → --color-primary → bg-primary
```

### 2. Component Architecture

```
Base styles → Variants → Sizes → States → Overrides
```

## Quick Start

```css
/* app.css - Tailwind v4 CSS-first configuration */
@import "tailwindcss";

@theme {
  --color-background: oklch(100% 0 0);
  --color-foreground: oklch(14.5% 0.025 264);
  --color-primary: oklch(14.5% 0.025 264);
  --color-primary-foreground: oklch(98% 0.01 264);
  --color-secondary: oklch(96% 0.01 264);
  --color-secondary-foreground: oklch(14.5% 0.025 264);
  --color-muted: oklch(96% 0.01 264);
  --color-muted-foreground: oklch(46% 0.02 264);
  --color-accent: oklch(96% 0.01 264);
  --color-accent-foreground: oklch(14.5% 0.025 264);
  --color-destructive: oklch(53% 0.22 27);
  --color-destructive-foreground: oklch(98% 0.01 264);
  --color-border: oklch(91% 0.01 264);
  --color-ring: oklch(14.5% 0.025 264);
  --color-card: oklch(100% 0 0);
  --color-card-foreground: oklch(14.5% 0.025 264);

  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
}

@custom-variant dark (&:where(.dark, .dark *));

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground antialiased; }
}
```

## Key Patterns

### CVA (Class Variance Authority) Components

```typescript
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border bg-background hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)
```

### Custom Utilities with `@utility`

```css
@utility line-t {
  @apply relative before:absolute before:top-0 before:-left-[100vw] before:h-px before:w-[200vw] before:bg-gray-950/5 dark:before:bg-white/10;
}
```

### Utility Function

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

## v3 to v4 Migration Checklist

* Replace `tailwind.config.ts` with CSS `@theme` block
* Change `@tailwind base/components/utilities` to `@import "tailwindcss"`
* Move color definitions to `@theme { --color-*: value }`
* Replace `darkMode: "class"` with `@custom-variant dark`
* Move `@keyframes` inside `@theme` blocks
* Update `h-10 w-10` to `size-10` (new utility)
* Remove `forwardRef` (React 19 passes ref as prop)
* Consider OKLCH colors for better color perception
* Replace custom plugins with `@utility` directives

## Best Practices

### Do's

* **Use `@theme` blocks** - CSS-first configuration is v4's core pattern
* **Use OKLCH colors** - Better perceptual uniformity than HSL
* **Compose with CVA** - Type-safe variants
* **Use semantic tokens** - `bg-primary` not `bg-blue-500`
* **Use `size-*`** - New shorthand for `w-* h-*`
* **Add accessibility** - ARIA attributes, focus states

### Don'ts

* **Don't use `tailwind.config.ts`** - Use CSS `@theme` instead
* **Don't use `@tailwind` directives** - Use `@import "tailwindcss"`
* **Don't use `forwardRef`** - React 19 passes ref as prop
* **Don't use arbitrary values** - Extend `@theme` instead
* **Don't hardcode colors** - Use semantic tokens
* **Don't forget dark mode** - Test both themes
