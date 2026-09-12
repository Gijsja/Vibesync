## 2026-09-12 - Keyboard Accessibility for Queue Pills
**Learning:** The attention queue UI in the HUD relied on interactive `span` elements without semantic roles or keyboard focus indicators, which is a common accessibility gap in custom vanity UI components.
**Action:** When working on custom interactive elements in ambient HUDs, default to using semantic `<button>` tags and ensure `:focus-visible` styles are explicitly defined, as they often get missed in custom implementations.
