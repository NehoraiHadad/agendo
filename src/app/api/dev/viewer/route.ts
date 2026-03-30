import { NextRequest } from 'next/server';
import { readdir, stat } from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

/** Allowed root directories for browsing */
const ALLOWED_ROOTS = ['/home/ubuntu/projects', '/tmp'];

const IMAGE_EXTS = new Set([
  '.webp',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.bmp',
  '.avif',
  '.ico',
]);

const VIDEO_EXTS = new Set(['.mp4', '.webm']);

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: Date;
  isImage: boolean;
  isVideo: boolean;
}

function isPathAllowed(resolvedPath: string): boolean {
  return ALLOWED_ROOTS.some((root) => resolvedPath.startsWith(root + '/') || resolvedPath === root);
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getEntries(dirPath: string): Promise<FileEntry[]> {
  const names = await readdir(dirPath);
  const entries: FileEntry[] = [];

  await Promise.all(
    names.map(async (name) => {
      try {
        const fullPath = path.join(dirPath, name);
        const s = await stat(fullPath);
        const ext = path.extname(name).toLowerCase();
        entries.push({
          name,
          path: fullPath,
          isDir: s.isDirectory(),
          size: s.size,
          modified: s.mtime,
          isImage: IMAGE_EXTS.has(ext),
          isVideo: VIDEO_EXTS.has(ext),
        });
      } catch {
        // Skip entries we can't stat (broken symlinks, etc.)
      }
    }),
  );

  // Directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

function buildBreadcrumbs(dirPath: string): string {
  const parts = dirPath.split('/').filter(Boolean);
  let html = '';
  let accumulated = '';

  for (let i = 0; i < parts.length; i++) {
    accumulated += '/' + parts[i];
    const isLast = i === parts.length - 1;
    if (isLast) {
      html += `<span class="current">${escapeHtml(parts[i])}</span>`;
    } else {
      html += `<a href="/api/dev/viewer?dir=${encodeURIComponent(accumulated)}">${escapeHtml(parts[i])}</a>`;
      html += '<span class="sep">/</span>';
    }
  }

  return html;
}

function renderPage(dirPath: string, entries: FileEntry[]): string {
  const images = entries.filter((e) => e.isImage);
  const hasImages = images.length > 0;
  const breadcrumbs = buildBreadcrumbs(dirPath);
  const parentDir = path.dirname(dirPath);
  const hasParent = isPathAllowed(parentDir) && parentDir !== dirPath;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(dirPath)} - File Viewer</title>
<style>
  :root {
    --bg: #0a0a0b;
    --bg-card: #141416;
    --bg-hover: #1c1c20;
    --border: #27272a;
    --text: #fafafa;
    --text-muted: #71717a;
    --accent: #3b82f6;
    --accent-hover: #60a5fa;
    --radius: 8px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 24px;
    max-width: 1400px;
    margin: 0 auto;
  }

  /* Breadcrumbs */
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .breadcrumbs a {
    color: var(--accent);
    text-decoration: none;
  }
  .breadcrumbs a:hover { color: var(--accent-hover); }
  .breadcrumbs .sep { color: var(--text-muted); margin: 0 2px; }
  .breadcrumbs .current { color: var(--text); font-weight: 600; }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .header h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
  }
  .header .meta {
    color: var(--text-muted);
    font-size: 13px;
  }

  /* View toggle */
  .view-toggle {
    display: flex;
    gap: 4px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px;
  }
  .view-toggle button {
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .view-toggle button.active {
    background: var(--bg-hover);
    color: var(--text);
  }
  .view-toggle button:hover:not(.active) { color: var(--text); }

  /* File list */
  .file-list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .file-row {
    display: grid;
    grid-template-columns: 1fr 100px 180px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
    text-decoration: none;
    color: var(--text);
    transition: background 0.1s;
    align-items: center;
  }
  .file-row:last-child { border-bottom: none; }
  .file-row:hover { background: var(--bg-hover); }
  .file-row .name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .file-row .name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-row .size { color: var(--text-muted); text-align: right; font-variant-numeric: tabular-nums; }
  .file-row .date { color: var(--text-muted); text-align: right; font-variant-numeric: tabular-nums; }
  .file-row .icon { flex-shrink: 0; width: 18px; text-align: center; }
  .file-row.dir .name span { color: var(--accent); }

  /* Image grid */
  .image-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .image-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s;
  }
  .image-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .image-card img {
    width: 100%;
    height: 180px;
    object-fit: cover;
    display: block;
    background: #000;
  }
  .image-card .caption {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Lightbox */
  .lightbox {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.92);
    z-index: 1000;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    gap: 12px;
    cursor: pointer;
  }
  .lightbox.open { display: flex; }
  .lightbox img {
    max-width: 95vw;
    max-height: 85vh;
    object-fit: contain;
    border-radius: var(--radius);
  }
  .lightbox .lb-caption {
    color: var(--text-muted);
    font-size: 14px;
    text-align: center;
    max-width: 90vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lightbox .lb-close {
    position: absolute;
    top: 16px;
    right: 20px;
    color: var(--text-muted);
    font-size: 28px;
    cursor: pointer;
    background: none;
    border: none;
    line-height: 1;
  }
  .lightbox .lb-close:hover { color: var(--text); }
  .lightbox .lb-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    font-size: 36px;
    cursor: pointer;
    background: none;
    border: none;
    padding: 20px;
    line-height: 1;
  }
  .lightbox .lb-nav:hover { color: var(--text); }
  .lightbox .lb-prev { left: 8px; }
  .lightbox .lb-next { right: 8px; }

  /* Section */
  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 24px 0 12px;
  }

  @media (max-width: 640px) {
    body { padding: 12px; }
    .file-row { grid-template-columns: 1fr 80px; }
    .file-row .date { display: none; }
    .image-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
    .image-card img { height: 120px; }
  }
</style>
</head>
<body>

<div class="breadcrumbs">${breadcrumbs}</div>

<div class="header">
  <h1>${escapeHtml(path.basename(dirPath))}</h1>
  <span class="meta">${entries.length} item${entries.length !== 1 ? 's' : ''}${hasImages ? ` (${images.length} image${images.length !== 1 ? 's' : ''})` : ''}</span>
</div>

${
  hasImages
    ? `
<div class="view-toggle">
  <button id="btn-list" class="active" onclick="setView('list')">List</button>
  <button id="btn-grid" onclick="setView('grid')">Grid</button>
</div>

<div id="image-grid-section" style="display:none">
  <div class="section-title">Images</div>
  <div class="image-grid">
    ${images
      .map(
        (e, i) => `
    <div class="image-card" onclick="openLightbox(${i})">
      <img src="/api/dev/files?path=${encodeURIComponent(e.path)}" alt="${escapeHtml(e.name)}" loading="lazy">
      <div class="caption">${escapeHtml(e.name)} &middot; ${formatSize(e.size)}</div>
    </div>`,
      )
      .join('')}
  </div>
</div>
`
    : ''
}

<div id="file-list-section">
  <div class="file-list">
    ${
      hasParent
        ? `<a class="file-row dir" href="/api/dev/viewer?dir=${encodeURIComponent(parentDir)}">
      <div class="name"><span class="icon">..</span><span>Parent directory</span></div>
      <div class="size"></div>
      <div class="date"></div>
    </a>`
        : ''
    }
    ${entries
      .map((e) => {
        if (e.isDir) {
          return `<a class="file-row dir" href="/api/dev/viewer?dir=${encodeURIComponent(e.path)}">
          <div class="name"><span class="icon">&#128193;</span><span>${escapeHtml(e.name)}</span></div>
          <div class="size">&mdash;</div>
          <div class="date">${formatDate(e.modified)}</div>
        </a>`;
        }
        const fileUrl = `/api/dev/files?path=${encodeURIComponent(e.path)}`;
        return `<a class="file-row" href="${fileUrl}" target="_blank">
        <div class="name"><span class="icon">${e.isImage ? '&#128248;' : e.isVideo ? '&#127909;' : '&#128196;'}</span><span>${escapeHtml(e.name)}</span></div>
        <div class="size">${formatSize(e.size)}</div>
        <div class="date">${formatDate(e.modified)}</div>
      </a>`;
      })
      .join('')}
  </div>
</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox" onclick="closeLightbox(event)">
  <button class="lb-close" onclick="closeLightbox(event)">&times;</button>
  <button class="lb-nav lb-prev" onclick="navLightbox(event, -1)">&#8249;</button>
  <button class="lb-nav lb-next" onclick="navLightbox(event, 1)">&#8250;</button>
  <img id="lb-img" src="" alt="">
  <div class="lb-caption" id="lb-caption"></div>
</div>

<script>
const images = ${JSON.stringify(images.map((e) => ({ name: e.name, url: `/api/dev/files?path=${encodeURIComponent(e.path)}`, size: formatSize(e.size) })))};
let currentIdx = 0;

function setView(mode) {
  const grid = document.getElementById('image-grid-section');
  const list = document.getElementById('file-list-section');
  const btnList = document.getElementById('btn-list');
  const btnGrid = document.getElementById('btn-grid');
  if (mode === 'grid') {
    grid.style.display = 'block';
    list.style.display = 'none';
    btnGrid.classList.add('active');
    btnList.classList.remove('active');
  } else {
    grid.style.display = 'none';
    list.style.display = 'block';
    btnList.classList.add('active');
    btnGrid.classList.remove('active');
  }
}

function openLightbox(idx) {
  currentIdx = idx;
  updateLightbox();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox(e) {
  if (e.target.tagName === 'IMG' || e.target.classList.contains('lb-nav')) return;
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function navLightbox(e, dir) {
  e.stopPropagation();
  currentIdx = (currentIdx + dir + images.length) % images.length;
  updateLightbox();
}

function updateLightbox() {
  const img = images[currentIdx];
  document.getElementById('lb-img').src = img.url;
  document.getElementById('lb-caption').textContent = img.name + ' \\u00b7 ' + img.size;
}

document.addEventListener('keydown', function(e) {
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('open')) return;
  if (e.key === 'Escape') { lb.classList.remove('open'); document.body.style.overflow = ''; }
  if (e.key === 'ArrowLeft') { currentIdx = (currentIdx - 1 + images.length) % images.length; updateLightbox(); }
  if (e.key === 'ArrowRight') { currentIdx = (currentIdx + 1) % images.length; updateLightbox(); }
});
</script>
</body>
</html>`;
}

/**
 * GET /api/dev/viewer?dir=...
 * HTML directory browser with image grid/lightbox, breadcrumbs, and file listing.
 */
export async function GET(req: NextRequest) {
  const dirPath = req.nextUrl.searchParams.get('dir');

  if (!dirPath) {
    // Show root picker
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>File Viewer</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0b; color: #fafafa; padding: 48px; max-width: 600px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 24px; }
  a { color: #3b82f6; text-decoration: none; display: block; padding: 12px 16px; border: 1px solid #27272a; border-radius: 8px; margin-bottom: 8px; transition: border-color 0.15s; }
  a:hover { border-color: #3b82f6; }
  .path { color: #71717a; font-size: 13px; margin-top: 4px; }
</style></head><body>
<h1>File Viewer</h1>
${ALLOWED_ROOTS.map((r) => `<a href="/api/dev/viewer?dir=${encodeURIComponent(r)}">${escapeHtml(path.basename(r))}<div class="path">${escapeHtml(r)}</div></a>`).join('')}
</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const resolved = path.resolve(dirPath);

  if (!isPathAllowed(resolved)) {
    return new Response(JSON.stringify({ error: 'Path not allowed', allowed: ALLOWED_ROOTS }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const dirStat = await stat(resolved);
    if (!dirStat.isDirectory()) {
      return new Response(JSON.stringify({ error: 'Not a directory' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const entries = await getEntries(resolved);
    const html = renderPage(resolved, entries);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new Response(JSON.stringify({ error: 'Directory not found', path: resolved }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
