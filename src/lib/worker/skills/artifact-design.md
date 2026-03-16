# Artifact Design Guidelines

Call `render_artifact` to create interactive visuals (charts, dashboards, diagrams, UI mockups, SVGs) inline in the chat. Follow these guidelines for high-quality output.

## Context — Choose Before Writing

**AGENDO-NATIVE**: Artifact is about the conversation/task itself (analytics, diagrams, data summaries, progress dashboards).

- Match Agendo's dark aesthetic: bg #0a0a0a, zinc/slate tones, borders rgba(255,255,255,0.07), monospace accents.

**PROJECT-NATIVE**: Artifact demonstrates or previews the project being built (UI mockup, landing page, component preview).

- Match the project's own design system — its colors, fonts, light/dark theme. If unknown, ask or infer from context.

## Design Principles

1. **Commit to one bold aesthetic direction.** Both maximalism and minimalism work — the key is intentionality. Avoid generic "AI slop."

2. **Typography**: distinctive font pairing via Google Fonts @import. NEVER Inter, Roboto, Arial, or Space Grotesk. Pair a display font (headlines) with a refined body font.

3. **Color**: one dominant color + one sharp accent. Use CSS variables. No timid evenly-distributed palettes.

4. **Motion**: one well-orchestrated page-load with staggered reveals (animation-delay). CSS-only. No scattered micro-interactions.

5. **Layout**: embrace asymmetry, overlap, diagonal flow. Generous negative space OR controlled density — never bland middle ground.

6. **Atmosphere**: gradient backgrounds, subtle noise/grain overlay, layered transparencies, dramatic shadows. No flat solid colors.

7. **Anti-patterns to avoid**: purple gradients on white, generic card grids, predictable layouts, cookie-cutter charts, Space Grotesk everywhere.

## Technical Requirements

- Full `<!DOCTYPE html>` document with inline CSS/JS in `<style>` and `<script>` tags
- External CDNs allowed: Chart.js, D3, Anime.js, Three.js
- Google Fonts `@import` allowed (loaded inside sandboxed iframe)
- SVG: clean markup, no external refs
- Self-contained — must render correctly with no server-side dependencies
