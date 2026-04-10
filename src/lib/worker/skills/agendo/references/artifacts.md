# Artifacts & File Sharing Reference

## When to Use What

| You want to...                                 | Use                                          | Why                                         |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Show a chart, diagram, or interactive visual   | `render_artifact` (type: `html`)             | Renders inline in session view, interactive |
| Show a clean vector graphic or icon            | `render_artifact` (type: `svg`)              | Lightweight, scales perfectly               |
| Let the user download or view a generated file | File server link: `/api/dev/files?path=...`  | Direct file access with correct MIME type   |
| Let the user browse a directory of outputs     | Viewer link: `/api/dev/viewer?dir=...`       | Full directory browser with previews        |
| Include a local image/file inside an artifact  | File server `<img>` / `<a>` in artifact HTML | Avoids base64 bloat, keeps artifacts small  |

---

## render_artifact

Creates an interactive visual that appears inline in the session chat. Stored in the database, so it persists across page reloads.

### Parameters

| Param     | Type                | Required | Description                                   |
| --------- | ------------------- | -------- | --------------------------------------------- |
| `title`   | string              | Yes      | Short descriptive title (max 500 chars)       |
| `content` | string              | Yes      | Full `<!DOCTYPE html>` document or SVG markup |
| `type`    | `"html"` \| `"svg"` | No       | Defaults to `"html"`                          |

### HTML Artifacts

Write a complete HTML document with inline `<style>` and `<script>` tags. The content renders inside a sandboxed iframe, so it must be self-contained.

**Allowed external resources:**

- Google Fonts via `@import`
- CDN libraries: Chart.js, D3.js, Anime.js, Three.js

**Example — project status dashboard:**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
      body {
        font-family: 'JetBrains Mono', monospace;
        background: #0a0a0a;
        color: #e5e5e5;
        padding: 24px;
      }
      .metric {
        font-size: 2.5rem;
        font-weight: 700;
        color: #22c55e;
      }
    </style>
  </head>
  <body>
    <h2>Sprint Progress</h2>
    <div class="metric">73% complete</div>
    <p>12 of 16 tasks done · 2 in progress · 2 blocked</p>
  </body>
</html>
```

### SVG Artifacts

Pass clean SVG markup directly. No external references — everything must be inline.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <rect width="400" height="200" fill="#0a0a0a" rx="8"/>
  <text x="200" y="110" text-anchor="middle" fill="#e5e5e5"
        font-family="system-ui" font-size="24">Architecture Overview</text>
</svg>
```

### Design Guidelines

The `artifact-design` skill is automatically loaded when you call `render_artifact`. Key points:

- **Choose context first**: "agendo-native" (dark theme, zinc tones) vs "project-native" (match the project's design)
- **Be bold**: commit to one aesthetic direction — avoid generic layouts
- **Typography**: use distinctive Google Fonts pairs, avoid Inter/Roboto/Arial
- **Color**: one dominant + one accent, not evenly-distributed palettes
- **Motion**: CSS staggered reveals on load, not scattered micro-interactions

---

## File Server

Serves files from the local filesystem with correct MIME types and caching headers.

### Endpoint

```
GET /api/dev/files?path=<absolute-path>
```

### Allowed Directories

Only files under these roots are accessible (path traversal is blocked):

- `/home/ubuntu/projects`
- `/tmp`

Any path outside these roots returns HTTP 403.

### Supported File Types

| Category  | Extensions                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Images    | `.webp`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.avif`, `.bmp`, `.ico`        |
| Documents | `.pdf`, `.html`, `.css`, `.md`, `.txt`, `.csv`, `.xml`, `.yaml`, `.yml`, `.json` |
| Code      | `.js`, `.ts`, `.tsx`, `.jsx`, `.py`, `.sh`, `.go`, `.java`, `.rs`, `.rb`         |
| Media     | `.mp4`, `.webm`, `.mp3`, `.wav`                                                  |
| Archives  | `.zip`, `.gz`, `.tar`                                                            |
| Fonts     | `.woff`, `.woff2`, `.ttf`, `.otf`                                                |

### Using in Artifact HTML

Reference local files via their `/api/dev/files` URL — the artifact iframe resolves paths against the Agendo origin (localhost:4100):

```html
<!-- Show a generated image -->
<img src="/api/dev/files?path=/home/ubuntu/projects/my-app/output/chart.png" />

<!-- Link to a downloadable file -->
<a href="/api/dev/files?path=/tmp/report.pdf" download>Download Report</a>

<!-- Embed a video -->
<video src="/api/dev/files?path=/tmp/demo.mp4" controls width="100%"></video>
```

This is better than base64-encoding because:

- Artifacts stay small (the DB stores them, and PG NOTIFY has a ~7500 byte limit for real-time events)
- Images load on-demand instead of inflating the artifact payload
- The same file can be referenced from multiple artifacts

### Sharing File Links with the User

When you've generated output files that the user might want to access, include the file server URL in your response text. The user can open it directly in their browser:

```
I've generated the report at `/home/ubuntu/projects/my-app/output/report.pdf`.
You can view it here: http://localhost:4100/api/dev/files?path=/home/ubuntu/projects/my-app/output/report.pdf
```

### Error Responses

| Status | Cause                      |
| ------ | -------------------------- |
| 400    | Missing `?path=` parameter |
| 403    | Path outside allowed roots |
| 404    | File not found             |

---

## File Viewer (Directory Browser)

A full-featured HTML file browser for exploring directories.

### Endpoint

```
GET /api/dev/viewer?dir=<absolute-path>
```

Without `?dir=`, shows a root directory picker.

### Features

- Breadcrumb navigation
- File listing with size, modification date, and type icons
- Image grid view with lightbox (click to enlarge)
- List/grid view toggle for image directories
- Responsive design (works on mobile)
- Direct download links for each file

### When to Use

After generating multiple output files, give the user a viewer link so they can browse everything in one place:

```
render_artifact({
  title: "Generated Assets",
  type: "html",
  content: `<!DOCTYPE html>
    <html><body style="margin:0">
      <iframe src="/api/dev/viewer?dir=/home/ubuntu/projects/my-app/output"
              style="width:100%;height:500px;border:none"></iframe>
    </body></html>`
})
```

Or just share the URL in your response:

```
All generated files are at: http://localhost:4100/api/dev/viewer?dir=/home/ubuntu/projects/my-app/output
```

---

## Common Patterns

### Pattern: Generated Report with Charts

1. Generate chart images to a temp directory
2. Create an HTML artifact that references them via the file server
3. Share the viewer link for the full output directory

```
render_artifact({
  title: "Q4 Sales Report",
  type: "html",
  content: `<!DOCTYPE html>
    <html>
    <head><style>body { font-family: system-ui; background: #0a0a0a; color: #e5e5e5; padding: 24px; }</style></head>
    <body>
      <h1>Q4 Sales Report</h1>
      <img src="/api/dev/files?path=/tmp/charts/revenue.png" width="100%" />
      <img src="/api/dev/files?path=/tmp/charts/growth.png" width="100%" />
      <p><a href="/api/dev/viewer?dir=/tmp/charts" style="color:#60a5fa">Browse all charts →</a></p>
    </body>
    </html>`
})
```

### Pattern: Architecture Diagram (Pure SVG)

For static diagrams without interactivity, SVG is lighter:

```
render_artifact({
  title: "Service Architecture",
  type: "svg",
  content: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 400'>...</svg>"
})
```

### Pattern: Interactive Data Explorer (Chart.js)

For dynamic, interactive visuals:

```
render_artifact({
  title: "Performance Metrics",
  type: "html",
  content: `<!DOCTYPE html>
    <html>
    <head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head>
    <body>
      <canvas id="chart"></canvas>
      <script>
        new Chart(document.getElementById('chart'), {
          type: 'line',
          data: { labels: ['Jan','Feb','Mar'], datasets: [{ label: 'Requests', data: [120,350,280] }] }
        });
      </script>
    </body>
    </html>`
})
```
