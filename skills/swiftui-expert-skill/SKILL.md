---
name: swiftui-expert-skill
description: Build, review, or improve SwiftUI features with correct state management, modern API usage, Swift concurrency, and iOS 26+ Liquid Glass styling. Use for any SwiftUI task.
---

# SwiftUI Expert Skill

## Overview

Use this skill to build, review, or improve SwiftUI features with correct state management, modern API usage, Swift concurrency best practices, optimal view composition, and iOS 26+ Liquid Glass styling. Prioritize native APIs, Apple design guidance, and performance-conscious patterns.

## Core Guidelines

### State Management

* **Always prefer `@Observable` over `ObservableObject`** for new code
* **Mark `@Observable` classes with `@MainActor`** unless using default actor isolation
* **Always mark `@State` and `@StateObject` as `private`**
* **Never declare passed values as `@State` or `@StateObject`**
* Use `@State` with `@Observable` classes (not `@StateObject`)
* `@Binding` only when child needs to **modify** parent state
* `@Bindable` for injected `@Observable` objects needing bindings
* Use `let` for read-only values; `var` + `.onChange()` for reactive reads

### Property Wrapper Selection (Modern)

| Wrapper   | Use When                                                          |
| --------- | ----------------------------------------------------------------- |
| @State    | Internal view state (must be private), or owned @Observable class |
| @Binding  | Child modifies parent's state                                     |
| @Bindable | Injected @Observable needing bindings                             |
| let       | Read-only value from parent                                       |
| var       | Read-only value watched via .onChange()                            |

### Modern APIs

* Use `foregroundStyle()` instead of `foregroundColor()`
* Use `clipShape(.rect(cornerRadius:))` instead of `cornerRadius()`
* Use `Tab` API instead of `tabItem()`
* Use `Button` instead of `onTapGesture()` (unless need location/count)
* Use `NavigationStack` instead of `NavigationView`
* Use `navigationDestination(for:)` for type-safe navigation
* Use `.sheet(item:)` instead of `.sheet(isPresented:)` for model-based content
* Avoid `UIScreen.main.bounds` for sizing
* Avoid `GeometryReader` when alternatives exist (e.g., `containerRelativeFrame()`)

### View Composition

* **Prefer modifiers over conditional views** for state changes (maintains view identity)
* Extract complex views into separate subviews
* Keep view `body` simple and pure (no side effects)
* Use `@ViewBuilder` functions only for small, simple sections
* Separate business logic into testable models

### Performance

* Pass only needed values to views (avoid large "config" objects)
* Eliminate unnecessary dependencies to reduce update fan-out
* Check for value changes before assigning state in hot paths
* Use `LazyVStack`/`LazyHStack` for large lists
* Use stable identity for `ForEach` (never `.indices` for dynamic content)
* Avoid `AnyView` in list rows
* Use `Self._printChanges()` to debug unexpected view updates

### Animations

* Use `.animation(_:value:)` with value parameter
* Use `withAnimation` for event-driven animations
* Prefer transforms (`offset`, `scale`, `rotation`) over layout changes for performance
* Use `.phaseAnimator` for multi-step sequences (iOS 17+)
* Use `.keyframeAnimator` for precise timing control (iOS 17+)

### Liquid Glass (iOS 26+)

**Only adopt when explicitly requested by the user.**

* Use native `glassEffect`, `GlassEffectContainer`, and glass button styles
* Apply `.glassEffect()` after layout and visual modifiers
* Use `.interactive()` only for tappable/focusable elements
* Gate with `#available(iOS 26, *)` and provide fallbacks

```swift
if #available(iOS 26, *) {
    content
        .padding()
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
} else {
    content
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
}
```

## Review Checklist

- Using `@Observable` instead of `ObservableObject` for new code
- `@State` and `@StateObject` properties are `private`
- Passed values NOT declared as `@State` or `@StateObject`
- Using modern API replacements (foregroundStyle, clipShape, NavigationStack, etc.)
- Complex views extracted to separate subviews
- ForEach uses stable identity (not `.indices`)
- No `AnyView` in list rows
- Animations use value parameter
- Liquid Glass gated with `#available` and fallbacks provided
