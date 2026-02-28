---
name: mobile-android-design
description: Build modern Android apps with Material Design 3 and Jetpack Compose, including theming, navigation, adaptive layouts, and accessibility. Use for Android UI tasks.
---

# Android Mobile Design

Master Material Design 3 (Material You) and Jetpack Compose to build modern, adaptive Android applications.

## When to Use This Skill

* Designing Android app interfaces following Material Design 3
* Building Jetpack Compose UI and layouts
* Implementing Android navigation patterns (Navigation Compose)
* Creating adaptive layouts for phones, tablets, and foldables
* Using Material 3 theming with dynamic colors
* Building accessible Android interfaces

## Core Concepts

### Material Design 3 Principles

* **Personalization**: Dynamic color adapts UI to user's wallpaper
* **Accessibility**: Tonal palettes ensure sufficient color contrast
* **Large Screens**: Responsive layouts for tablets and foldables

### Jetpack Compose Layout

```kotlin
Column(
    modifier = Modifier.padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    horizontalAlignment = Alignment.Start
) {
    Text(text = "Title", style = MaterialTheme.typography.headlineSmall)
    Text(
        text = "Subtitle",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}
```

### Navigation: Bottom Navigation

```kotlin
@Composable
fun MainScreen() {
    val navController = rememberNavController()
    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationDestination.entries.forEach { destination ->
                    NavigationBarItem(
                        icon = { Icon(destination.icon, contentDescription = null) },
                        label = { Text(destination.label) },
                        selected = /* check current destination */,
                        onClick = {
                            navController.navigate(destination.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(navController, startDestination = "home", Modifier.padding(innerPadding)) {
            composable("home") { HomeScreen() }
            composable("search") { SearchScreen() }
            composable("profile") { ProfileScreen() }
        }
    }
}
```

### Material 3 Theming

```kotlin
// Dynamic color (Android 12+)
val dynamicColorScheme = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    val context = LocalContext.current
    if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
} else {
    if (darkTheme) DarkColorScheme else LightColorScheme
}
```

### Card Component

```kotlin
@Composable
fun FeatureCard(title: String, description: String, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
```

### Button Variants

```kotlin
Button(onClick = { }) { Text("Continue") }                       // Primary
FilledTonalButton(onClick = { }) { Text("Add Item") }            // Secondary
OutlinedButton(onClick = { }) { Text("Cancel") }                 // Outlined
TextButton(onClick = { }) { Text("Learn More") }                 // Text
FloatingActionButton(onClick = { }) { Icon(Icons.Default.Add, "Add") } // FAB
```

## Best Practices

1. **Use Material Theme**: Access colors via `MaterialTheme.colorScheme` for automatic dark mode
2. **Support Dynamic Color**: Enable dynamic color on Android 12+ for personalization
3. **Adaptive Layouts**: Use `WindowSizeClass` for responsive designs
4. **Content Descriptions**: Add `contentDescription` to all interactive elements
5. **Touch Targets**: Minimum 48dp touch targets for accessibility
6. **State Hoisting**: Hoist state to make components reusable and testable
7. **Remember Properly**: Use `remember` and `rememberSaveable` appropriately
8. **Preview Annotations**: Add `@Preview` with different configurations

## Common Issues

* **Recomposition Issues**: Avoid passing unstable lambdas; use `remember`
* **State Loss**: Use `rememberSaveable` for configuration changes
* **Performance**: Use `LazyColumn` instead of `Column` for long lists
* **Theme Leaks**: Ensure `MaterialTheme` wraps all composables
* **Navigation Crashes**: Handle back press and deep links properly
* **Memory Leaks**: Cancel coroutines in `DisposableEffect`
