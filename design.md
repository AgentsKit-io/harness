# Harness Home Design

The Harness home is part of the AgentsKit ecosystem, with its own green workflow identity. Its visual system makes an automated SDLC loop feel legible, controlled, and calm. The documentation remains a quiet reading surface and does not use the home-page cursor effect.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0D1117` | Home canvas and deep code surfaces |
| Surface | `#161B22` | Diagrams, cards, controls |
| Border | `#30363D` | Hairlines and component edges; lower-opacity on glass |
| Foreground | `#E6EDF3` | Primary text |
| Muted | `#8B949E` | Supporting text and labels |
| Blue | `#58A6FF` | Links, focus, selected technical detail |
| Harness green | `#56D364` | Harness identity, active workflow and positive state |
| Green state | `#2EA043` | Completed workflow states |

The home defaults to dark and reuses the AgentsKit ambient blue/green radial background and pointer-following liquid gradient. Let the background provide depth while Harness green remains a functional workflow accent. Keep status colors legible in diagrams and terminal output without tinting every surface.

## Typography

- **Space Grotesk** for the product wordmark and display headings, with tight tracking and fluid sizes.
- **Inter** for paragraphs, controls, and general interface text.
- **JetBrains Mono** for commands, timestamps, state labels, and compact eyebrows.
- Keep paragraphs around 60–65 characters wide, with comfortable line-height; use uppercase mono labels sparingly.

## Surfaces, borders, and shape

- Use `#161B22` for legible content surfaces and translucent dark glass for floating chrome and focused interactive panels.
- Match the AgentsKit glass treatment in the sticky local header. Keep the footer on the open page canvas. Workflow diagrams may use subtle individual node surfaces, but should not sit inside an extra enclosing card.
- Keep shell commands on a distinct dark code surface with the CLI name picked out in Harness green; the current Harness entry gets the same restrained emphasis in the ecosystem footer.
- Use 16–20px card radii and pill radii for compact actions. Hairline borders should remain visible against the dark background without boxing every section.
- Preserve the global ecosystem bar as the shared component; do not implement a Harness-specific variation.

## Motion

- Reuse the AgentsKit liquid cursor treatment and intensity: softly blurred blue/green orbs follow mouse or pen movement with spring-like easing. Keep the effect behind content, ignore touch input, and honor reduced motion.
- Preserve the SDLC loop and terminal replay because they explain Harness. Keep their existing play/pause behavior; animate flow profiles in one configurable preview instead of presenting profile selectors.
- Honor `prefers-reduced-motion`: freeze decorative movement and remove cursor transitions. Do not apply home motion or gradients to documentation routes.

## Responsive behavior

- Use fluid display typography and stack the hero copy and loop diagram on narrow screens.
- Keep controls comfortably tappable, allow code to scroll within its own surface, and avoid horizontal page overflow.
- Simplify secondary SVG branches on narrow viewports while retaining the primary workflow and its meaning.

## Accessibility

- Maintain readable contrast for primary and supporting text, visible keyboard focus, and semantic names for controls and diagrams.
- Do not communicate workflow states through color alone; retain labels and symbols.
- Respect reduced-motion settings and ensure the liquid layer is decorative (`aria-hidden`) and never intercepts input.

## Components and boundaries

- Reuse the AgentsKit liquid cursor implementation pattern; no new UI dependency is needed.
- Keep the Harness SDLC loop SVG, terminal replay, profile controls, and shared ecosystem bar behavior intact. Use its `agentskit-home` visual variant so the six-product tour matches the current AgentsKit home.
- Scope these visual rules to the home route. Documentation stays dark-capable, still, and optimized for reading.
