# Next.js 16 & 16.1 Research for Agent Monitor Project

**Research date:** 2026-02-17
**Current stable version:** Next.js 16.1.6
**Sources:** Official Next.js blog, docs, and migration guides

---

## 1. Next.js 16 Release (October 21, 2025)

**Source:** https://nextjs.org/blog/next-16

### Major New Features

1. **Cache Components** - New caching model using `"use cache"` directive. Replaces `experimental.ppr` and `experimental.dynamicIO`. All caching is now opt-in (not implicit like previous App Router versions). Enabled via `cacheComponents: true` in `next.config.ts`.

2. **proxy.ts (replaces middleware.ts)** - `middleware.ts` is deprecated, renamed to `proxy.ts`. The proxy runs on Node.js runtime only (edge is NOT supported in proxy). If you need Edge runtime, keep using `middleware.ts` (deprecated, will be removed in future).

3. **Turbopack (stable, now default)** - Default bundler for both `next dev` and `next build`. No more `--turbopack` flag needed. Opt out with `--webpack` flag.

4. **React Compiler Support (stable)** - Built-in support, promoted from `experimental`. Not enabled by default. Config: `reactCompiler: true`.

5. **React 19.2 + Canary Features** - View Transitions, `useEffectEvent()`, `<Activity/>` component.

6. **New Caching APIs:**
   - `updateTag()` - Server Actions only, read-your-writes semantics
   - `refresh()` - Server Actions only, refreshes uncached data
   - `revalidateTag()` updated - now requires `cacheLife` profile as 2nd arg

7. **Enhanced Routing** - Layout deduplication, incremental prefetching. No code changes needed.

8. **Next.js DevTools MCP** - Model Context Protocol integration for AI-assisted debugging.

9. **Build Adapters API (alpha)** - Custom adapters to modify build process.

### Version Requirements

| Requirement | Version            |
| ----------- | ------------------ |
| Node.js     | >= 20.9.0 (LTS)    |
| TypeScript  | >= 5.1.0           |
| React       | 19.2+ (via canary) |
| Chrome/Edge | 111+               |
| Firefox     | 111+               |
| Safari      | 16.4+              |

### React Version Details

Next.js 16 uses the latest React Canary release, which includes React 19.2 features. When you run `npm install next@latest react@latest react-dom@latest`, you get the compatible React version. The App Router internally uses React canary features that are incrementally stabilized.

**For the Agent Monitor project:** Install with `npm install next@latest react@latest react-dom@latest`. The installed React version will be compatible automatically.

---

## 2. Next.js 16.1 Release (December 18, 2025)

**Source:** https://nextjs.org/blog/next-16-1

### Key Improvements

1. **Turbopack File System Caching (stable, on by default)** - Compiler artifacts stored on disk. Massive speedups on restart:
   - react.dev: ~10x faster (3.7s cold -> 380ms cached)
   - nextjs.org: ~5x faster (3.5s cold -> 700ms cached)
   - Large Vercel app: ~14x faster (15s cold -> 1.1s cached)

2. **Next.js Bundle Analyzer (experimental)** - Works with Turbopack. Run: `next experimental-analyze`. Interactive UI for inspecting bundles.

3. **Easier debugging** - `next dev --inspect` enables Node.js debugger (previously needed `NODE_OPTIONS=--inspect`).

4. **Transitive external dependencies** - Turbopack now correctly resolves and externalizes transitive dependencies in `serverExternalPackages` without needing to add them to your own `package.json`. This was a major pain point.

5. **20MB smaller installs** - Simplifications in Turbopack FS caching layer.

6. **`next upgrade` command** - New command for easier upgrades.

7. **MCP `get_routes` tool** - DevTools MCP now has route listing.

8. **`generateStaticParams` timing** - Now logged in dev timings.

---

## 3. Breaking Changes: Next.js 15 -> 16

**Source:** https://nextjs.org/docs/app/guides/upgrading/version-16

### Critical Breaking Changes

#### 3.1 Async Request APIs (FULLY ENFORCED)

Next.js 15 introduced async request APIs with temporary sync compatibility. **Next.js 16 removes all synchronous access.** These must be awaited:

```typescript
// BEFORE (Next.js 15 - sync access still worked)
const cookieStore = cookies();
const headerList = headers();

// AFTER (Next.js 16 - MUST await)
const cookieStore = await cookies();
const headerList = await headers();
const { slug } = await params;
const query = await searchParams;
const mode = await draftMode();
```

Use the codemod: `npx @next/codemod@canary upgrade latest`

Type helpers available via `npx next typegen`:

```typescript
// app/blog/[slug]/page.tsx
export default async function Page(props: PageProps<'/blog/[slug]'>) {
  const { slug } = await props.params
  const query = await props.searchParams
  return <h1>Blog Post: {slug}</h1>
}
```

#### 3.2 Turbopack as Default Bundler

Turbopack is now the default. If you have a custom `webpack` config in `next.config.ts`, the build will **fail** to prevent misconfiguration.

Options:

- Remove webpack config and use Turbopack (recommended)
- Use `next build --webpack` to explicitly opt out
- Turbopack config moved from `experimental.turbopack` to top-level `turbopack`

```typescript
// next.config.ts (Next.js 16)
const nextConfig: NextConfig = {
  turbopack: {
    // options here (no longer under experimental)
  },
};
```

#### 3.3 middleware.ts -> proxy.ts

```bash
mv middleware.ts proxy.ts
```

```typescript
// proxy.ts
export function proxy(request: NextRequest) {
  return NextResponse.redirect(new URL('/home', request.url));
}
```

Key differences:

- `proxy.ts` runs on **Node.js runtime only** (not Edge)
- Runtime is NOT configurable
- Config flag renamed: `skipMiddlewareUrlNormalize` -> `skipProxyUrlNormalize`
- If you need Edge runtime, keep using `middleware.ts` (deprecated)

#### 3.4 Parallel Routes Require `default.js`

All parallel route slots now require explicit `default.js` files. Builds fail without them.

```typescript
// app/@modal/default.tsx
import { notFound } from 'next/navigation';
export default function Default() {
  notFound();
}
```

### Removals

| Removed                                       | Replacement                                     |
| --------------------------------------------- | ----------------------------------------------- |
| AMP support (all APIs)                        | None (use modern web standards)                 |
| `next lint` command                           | Run ESLint/Biome directly                       |
| `serverRuntimeConfig` / `publicRuntimeConfig` | Environment variables                           |
| `experimental.dynamicIO`                      | `cacheComponents: true`                         |
| `experimental.ppr` flag                       | `cacheComponents: true`                         |
| `export const experimental_ppr`               | Removed (use Cache Components)                  |
| Sync `params`, `searchParams`                 | Must use `await`                                |
| Sync `cookies()`, `headers()`, `draftMode()`  | Must use `await`                                |
| `devIndicators` (appIsrStatus, buildActivity) | Removed                                         |
| `unstable_rootParams()`                       | Alternative API coming in future minor          |
| Auto `scroll-behavior: smooth` override       | Add `data-scroll-behavior="smooth"` to `<html>` |

### Behavior Changes

| Change                           | Details                                           |
| -------------------------------- | ------------------------------------------------- |
| `images.minimumCacheTTL`         | 60s -> 4 hours (14400s)                           |
| `images.imageSizes`              | Removed `16` from defaults                        |
| `images.qualities`               | `[1..100]` -> `[75]`                              |
| `images.dangerouslyAllowLocalIP` | Blocks local IP by default                        |
| `images.maximumRedirects`        | Unlimited -> 3 max                                |
| `revalidateTag()`                | Requires cacheLife profile as 2nd arg             |
| `next dev` / `next build`        | Use separate output dirs (`.next/dev` vs `.next`) |
| Lockfile mechanism               | Prevents multiple dev/build instances             |
| ESLint plugin                    | Defaults to Flat Config format                    |
| Sass                             | Bumped to sass-loader v16                         |
| Dev/build output                 | `size` and `First Load JS` metrics removed        |

---

## 4. Turbopack Status in 16

### Development

- **Stable, default** since 16.0
- File system caching **stable and on by default** since 16.1
- No configuration needed

### Production Builds

- **Stable, default** since 16.0
- File system caching for `next build` still being stabilized (post-16.1)
- Opt out with `next build --webpack`

### Key Turbopack Config (Next.js 16)

```typescript
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack config is now top-level (not experimental)
  turbopack: {
    resolveAlias: {
      // Example: polyfill for client-side code
      fs: { browser: './empty.ts' },
    },
  },
};
export default nextConfig;
```

### Turbopack + Custom Webpack

If you have any webpack config (even from a plugin), Turbopack build will fail. You must either:

1. Migrate to Turbopack equivalents
2. Use `next build --webpack` explicitly

---

## 5. App Router, Server Actions, SSE, Middleware Changes

### 5.1 App Router with Route Groups

Route groups like `(dashboard)` are **unchanged** in Next.js 16. They continue to work exactly as before:

```
app/
  (dashboard)/
    layout.tsx
    page.tsx
    tasks/
      page.tsx
    agents/
      page.tsx
  (auth)/
    login/
      page.tsx
```

**Improvement in 16:** Layout deduplication means if you have 50 links in a `(dashboard)` group sharing a layout, that layout is downloaded once instead of 50 times during prefetching.

### 5.2 Server Actions for Mutations

Server Actions remain the primary mutation pattern. **Key changes:**

1. **New `updateTag()` API** (Server Actions only) - Read-your-writes semantics:

```typescript
'use server';
import { updateTag } from 'next/cache';

export async function updateTask(taskId: string, data: TaskData) {
  await db.tasks.update(taskId, data);
  updateTag(`task-${taskId}`); // User sees changes immediately
}
```

2. **New `refresh()` API** (Server Actions only) - Refresh uncached data:

```typescript
'use server';
import { refresh } from 'next/cache';

export async function markTaskComplete(taskId: string) {
  await db.tasks.markComplete(taskId);
  refresh(); // Refreshes dynamic data on the page
}
```

3. **`revalidateTag()` updated** - Now requires cache profile:

```typescript
'use server';
import { revalidateTag } from 'next/cache';

export async function publishContent(id: string) {
  revalidateTag(`content-${id}`, 'max'); // SWR behavior
}
```

4. `cacheLife` and `cacheTag` are now stable (no more `unstable_` prefix):

```typescript
import { cacheLife, cacheTag } from 'next/cache';
// Instead of:
// import { unstable_cacheLife as cacheLife } from 'next/cache'
```

### 5.3 SSE via Route Handlers (GET with ReadableStream)

SSE via route handlers with ReadableStream **continues to work in Next.js 16**. No breaking changes to this pattern.

**Working pattern for Next.js 16:**

```typescript
// app/api/events/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // IMPORTANT: Do NOT await async work here.
      // Start background work and let the Response return immediately.
      const interval = setInterval(() => {
        const data = JSON.stringify({ timestamp: Date.now() });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }, 1000);

      // Clean up on close
      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Prevent NGINX buffering
    },
  });
}
```

**Key notes for SSE in Next.js 16:**

- Route handlers are the correct approach (not Server Actions) for streaming
- Must use `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`
- The `X-Accel-Buffering: no` header is important if behind NGINX
- ReadableStream's `start()` should NOT await async operations - return Response immediately while stream is consumed in background
- With Turbopack as default, SSE route handlers work without any additional config

### 5.4 Middleware Changes (proxy.ts)

Covered in detail in Section 3.3 above. Summary for Agent Monitor:

- Rename `middleware.ts` to `proxy.ts`
- Rename exported function to `proxy`
- Now runs on Node.js runtime (good for auth checks, DB access)
- Cannot use Edge runtime in `proxy.ts`
- Matcher config syntax is the same

```typescript
// proxy.ts
import { NextResponse, NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // Auth check for dashboard routes
  if (request.nextUrl.pathname.startsWith('/dashboard')) {
    const token = request.cookies.get('session');
    if (!token) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
```

---

## 6. React Version Requirements

- **Next.js 16 requires React 19.2+** (installed via `react@latest`)
- The App Router uses React Canary features on top of 19.2
- Install command: `npm install next@latest react@latest react-dom@latest`
- TypeScript types: `npm install @types/react@latest @types/react-dom@latest`

### React 19.2 Features Available in Next.js 16

1. **View Transitions** - Animate elements during navigation/transitions
2. **`useEffectEvent()`** - Extract non-reactive logic from Effects
3. **`<Activity/>`** - Hide UI with `display: none` while maintaining state

---

## 7. Architecture Impact Assessment for Agent Monitor

### 7.1 Server Actions for Mutations - COMPATIBLE, ENHANCED

**Impact: Low (positive changes)**

Server Actions work the same as Next.js 15 but with new APIs:

- Use `updateTag()` for task mutations where users need to see changes instantly
- Use `refresh()` for refreshing agent status displays after actions
- `revalidateTag()` now needs a second argument (cache profile)

**Recommendation:** Use Server Actions as planned. The new `updateTag()` is perfect for task management mutations.

### 7.2 App Router with (dashboard) Route Groups - COMPATIBLE, NO CHANGES

**Impact: None**

Route groups are unchanged. The performance improvements (layout deduplication, incremental prefetching) apply automatically.

**One requirement:** If you use parallel routes (e.g., `@modal` slots), every slot now needs an explicit `default.js` file or the build will fail.

### 7.3 SSE via Route Handlers - COMPATIBLE, NO CHANGES

**Impact: None**

ReadableStream-based SSE in route handlers works identically. No API changes. Turbopack handles these correctly as default bundler.

**Recommendation:** Use the pattern shown in Section 5.3. Ensure `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` exports.

### 7.4 Drizzle ORM Compatibility - COMPATIBLE, IMPROVED

**Impact: Positive**

- Drizzle ORM is NOT on the default `serverExternalPackages` list, meaning it gets bundled by default (which is the correct behavior for Drizzle)
- `@libsql/client` IS on the default list (auto-externalized) -- relevant if using Turso/LibSQL
- `better-sqlite3`, `pg`, `sqlite3` are on the default list
- Next.js 16.1 fixes transitive dependency handling in Turbopack for `serverExternalPackages`

**Recommendation:** Drizzle ORM works out of the box. If using a native driver like `better-sqlite3`, it's auto-externalized. If you encounter issues, add specific packages to `serverExternalPackages` in `next.config.ts`.

```typescript
// next.config.ts (only if needed)
const nextConfig: NextConfig = {
  serverExternalPackages: ['your-native-package'],
};
```

### 7.5 Worker Process Importing from src/lib/ - NEEDS ATTENTION

**Impact: Medium**

If you have a separate worker process (not a Next.js route) that imports shared code from `src/lib/`:

1. **Development:** Works fine - both Next.js and the worker can import from `src/lib/` as long as they share the same TypeScript config or use compatible module resolution.

2. **Production (standalone output):** You need `outputFileTracingIncludes` to ensure shared files are included:

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/api/worker': ['./src/lib/**/*'],
  },
};
```

3. **Turbopack consideration:** If the worker uses `worker_threads` and imports modules that Turbopack doesn't trace, you may need manual configuration. Consider structuring shared code as a separate package or ensuring the worker is started independently (not bundled by Next.js).

**Recommendation:** Keep shared types/schemas in `src/lib/shared/` and ensure both Next.js and the worker can resolve them. For production, test standalone output thoroughly.

---

## 8. Recommended next.config.ts for Agent Monitor

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack is default - no flag needed
  // Optional: enable Cache Components for PPR-like behavior
  // cacheComponents: true,

  // Optional: React Compiler for auto-memoization
  // reactCompiler: true,

  // If using native DB drivers
  // serverExternalPackages: ['better-sqlite3'],

  // Image optimization
  images: {
    remotePatterns: [
      // Add your image domains here
    ],
  },
};

export default nextConfig;
```

### package.json scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

Note: No `--turbopack` flag needed (it's default now). No `--webpack` needed unless you have custom webpack config.

---

## 9. Migration Checklist (15 -> 16)

- [ ] Update deps: `npm install next@latest react@latest react-dom@latest`
- [ ] Ensure Node.js >= 20.9.0
- [ ] Ensure TypeScript >= 5.1.0
- [ ] Run codemod: `npx @next/codemod@canary upgrade latest`
- [ ] Await all `cookies()`, `headers()`, `draftMode()`, `params`, `searchParams`
- [ ] Rename `middleware.ts` to `proxy.ts`, function name to `proxy`
- [ ] Rename `skipMiddlewareUrlNormalize` to `skipProxyUrlNormalize` (if used)
- [ ] Move `experimental.turbopack` config to top-level `turbopack`
- [ ] Remove `--turbopack` flags from scripts (now default)
- [ ] Add `default.js` to all parallel route slots
- [ ] Remove any AMP-related code
- [ ] Replace `next lint` with direct ESLint/Biome invocation
- [ ] Replace `serverRuntimeConfig`/`publicRuntimeConfig` with env vars
- [ ] Update `revalidateTag()` calls to include cache profile 2nd arg
- [ ] Replace `unstable_cacheLife`/`unstable_cacheTag` with stable imports
- [ ] Review `next/image` usage for query strings (needs `localPatterns` config)
- [ ] Remove `experimental.dynamicIO` -> use `cacheComponents` if needed
- [ ] Remove `experimental.ppr` -> use `cacheComponents` if needed
- [ ] Test with Turbopack (or add `--webpack` to build script)

---

## 10. Key Links

- Next.js 16 Release Blog: https://nextjs.org/blog/next-16
- Next.js 16.1 Release Blog: https://nextjs.org/blog/next-16-1
- Version 16 Upgrade Guide: https://nextjs.org/docs/app/guides/upgrading/version-16
- proxy.ts Documentation: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
- cacheComponents Config: https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents
- serverExternalPackages: https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages
- React 19.2 Announcement: https://react.dev/blog/2025/10/01/react-19-2
- Turbopack Config: https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack
- Codemods Reference: https://nextjs.org/docs/app/guides/upgrading/codemods#160
