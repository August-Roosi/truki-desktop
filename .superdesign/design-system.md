# Truki Desktop design system

## Product and architecture

Truki is a fork of Signal Desktop. The renderer is a React/Electron desktop application with a three-region conversation layout: primary navigation, a resizable left sidebar, and the active content area. Navigation state is Redux-backed and represented by `NavTab` and `SettingsPage` rather than URL routes.

This redesign removes the dedicated far-left navigation rail. Chats, Calls, and Stories become one horizontal navigation group inside the resizable left sidebar, positioned 20px above its bottom edge. Settings is a separate gear action directly below that group.

When Settings is active, the ordinary left sidebar and its embedded navigation are absent. Settings occupies the available application content area and exposes a clear back button that returns to the previously active non-settings location.

## Visual language

- Preserve the existing Signal/Axo visual system; this is a structural change, not a rebrand.
- Use existing Axo colors only: secondary surface for sidebars, primary surface for content, primary/pressed fills for hover and selected states, primary border between regions, accent/destructive label tokens for badges.
- Preserve current system sans typography and existing title/body scales.
- Preserve compact 4px-based spacing, 8-12px corner radii, and existing iconography.
- Use the existing Chats, Calls, Stories, and Settings icons exactly; do not invent or substitute icons.
- Keep unread/error/update badges attached to their destination icon.
- Keep current focus rings, forced-colors support, screen-reader labels, tooltips, and native button semantics.

## Layout rules

- No persistent or expandable far-left rail and no hamburger/collapse affordance for it.
- Normal tabs retain the resizable left sidebar and main content split.
- The horizontal Chats/Calls/Stories group is anchored inside the left sidebar's lower region, not at the window edge.
- The group overlays the scrolling conversation list without reserving blank space; use a translucent material surface so list content remains perceptible behind it.
- Place the Settings gear immediately below the horizontal group, visually aligned with it.
- Settings removes the whole ordinary left sidebar, including the embedded destination group.
- Settings content fills the shell and includes a leading back action in its own header.
- The Settings category panel hugs its menu content instead of stretching to the bottom of the window; unused vertical space remains outside the panel.
- Settings uses the full available window width with 20px outer gutters and a 20px column gap; the detail pane grows to the right edge while the category panel remains capped at 360px.
- Preserve the existing title-bar drag region and window controls.
- Do not alter conversation content, message composer, calls list, stories content, or individual settings form styling.

## Interaction and motion

- Selecting Chats, Calls, or Stories changes the active tab using the existing location state.
- Selecting the gear opens Settings at the existing default settings location.
- Back from Settings restores the previously active non-settings location, including the previously selected chat where applicable.
- Keep state changes immediate and use existing pressed/selected transitions; add no decorative animation.
- The lower navigation must remain usable when the sidebar is resized to its narrow breakpoint.

## Implementation constraints

- Prefer new Truki-owned files for new behavior and small additive branches in upstream files.
- New UI uses Axo and `tw()`; avoid new SCSS unless overriding an existing CSS custom property is necessary.
- Preserve upstream behavior when Truki-specific inputs are absent.
- Maintain current user-facing localization patterns and add only English ICU keys when new copy is unavoidable.
