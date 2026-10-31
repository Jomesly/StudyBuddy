# StudyBuddy design system

StudyBuddy presents one task, its remaining time, and optional monitoring in a calm study workspace. Status language should help people return to their task without grading or scolding them.

## Layout and hierarchy

- Above 900px, the timer/setup card and camera card occupy equal columns. The camera preview starts expanded; the default desktop workspace fits a 1366 x 768 viewport.
- Smaller screens stack cards and allow natural scrolling. Navigation condenses as space decreases.
- Task, remaining time, session actions, and camera feed have the strongest hierarchy. Start and Pause/Resume sit in the timer card; camera controls stay beneath the feed.
- Monitoring settings, detection details, recent sessions, statistics, and privacy information expand when needed. Expanded content may increase page height.
- Preserve the session's existing Start, Pause/Resume, End, and break behavior across layouts.

## Visual language

| Role | Value |
| --- | --- |
| Canvas | `#f4f7f6` |
| Cards | White |
| Main text | `#203530` |
| Primary action | `#246b59` |
| Borders | `#dee8e3` |
| Card radius | 16px |
| Control radius | 9px |
| Typography | Bundled Inter, system sans-serif fallback |

Use consistent spacing, aligned controls, and soft tinted shadows. Timer numerals use tabular figures. Amber indicates a reminder; error colors indicate actionable failures. Dark mode preserves the same hierarchy with green charcoal surfaces.

## Interaction and accessibility

Keep one clear primary action per context. Use text alongside status colors, visible keyboard focus, explicit form labels, and readable contrast. Respect reduced motion and the selected light, dark, or system appearance. Destructive history deletion requires confirmation.

Camera permission failures, missing devices, disconnected engines, and session ownership conflicts must explain the next available action. Collapsing preview details and disabling capture are separate actions and must have distinct labels.

## Branding and compatibility

Use StudyBuddy in the page title, wordmark, interface copy, exports, and development messages. The book mark is shared by the wordmark and favicon. Legacy storage keys and protocol headers remain only where needed to preserve existing history, preferences, and local-engine compatibility.
