# Developer Experience Analysis

**Date:** 2026-03-06
**Scope:** First-run experience, dev workflow, README, UI empty states

---

## 1. `pnpm dev:all` — Single-Command Dev Start

### Current State

Development requires **three separate terminals**:

```bash
pnpm dev          # Terminal 1 — Next.js (port 4100)
pnpm worker:dev   # Terminal 2 — Worker (tsx watch)
pnpm tsx src/terminal/server.ts  # Terminal 3 — Terminal server (port 4101)
```

The setup script (`setup.sh --dev`) prints this as the final output, but there is no `dev:all` script to run them together. This is the single biggest friction point for new contributors.

### Options Compared

| Approach                  | Pros                                                                     | Cons                                                                       |
| ------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **`concurrently`** (npm)  | Color-coded prefixed output, kill-on-fail, mature (13M weekly downloads) | Extra dependency (~45KB)                                                   |
| **`npm-run-all2`**        | Parallel + serial combos, `--print-label`                                | Heavier API surface than needed, slightly less popular                     |
| **Custom Node.js script** | Zero deps, full control                                                  | Must build kill-group, color, restart logic from scratch                   |
| **Makefile**              | No npm dep needed                                                        | Parallel output is ugly, no color prefixing, not idiomatic for JS projects |

### Recommendation: `concurrently`

It's the standard for this exact use case. Minimal config:

```jsonc
// package.json scripts
"terminal:dev": "tsx src/terminal/server.ts",
"dev:all": "concurrently -k -n app,worker,term -c cyan,yellow,green \"pnpm dev\" \"pnpm worker:dev\" \"pnpm terminal:dev\""
```

Install: `pnpm add -D concurrently`

Output would look like:

```
[app]    - ready started server on 0.0.0.0:4100
[worker] [INFO] Worker started (worker-1), polling...
[term]   Terminal server listening on :4101
```

The `-k` flag kills all processes if any one exits, which is the right behavior for dev (if Next.js crashes, you want to see it, not have a headless worker running).

**Effort:** ~15 minutes. One dependency, one script line, update README.

---

## 2. First-Run Onboarding UI

### Current State

The dashboard already has a `WelcomeCard` component (`src/components/dashboard/welcome-card.tsx`) that shows when `totalTasks === 0 && recentEvents.length === 0`. It provides a 3-step checklist:

1. Agent CLIs — shows green check if agents discovered, or tells user to install + seed
2. Create a project — links to `/projects`
3. Create your first task — links to `/board`

**This is already good.** It's the right pattern (Linear, Vercel, and Notion all use step-based onboarding). But there are gaps:

### Gaps and Recommendations

#### Gap 1: Steps 2 and 3 never show "done"

The `done` prop is hardcoded to `false` for steps 2 and 3. They should query actual state:

```tsx
<Step number={2} title="Create a project" done={projectCount > 0} ... />
<Step number={3} title="Create your first task" done={false} ... /> // stays false — totalTasks===0 already hides the card
```

Fix: Pass `projectCount` from `getDashboardStats()` (it already queries projects — just expose the count). Step 3 is self-resolving since the WelcomeCard only shows when `totalTasks === 0`.

#### Gap 2: No guidance when agents are missing

If no CLIs are installed, the user sees "Install claude, codex, or gemini and run pnpm db:seed" — but no links to install docs and no explanation of what these agents _do_. New users who found Agendo via GitHub may not have any AI CLI installed yet.

Recommendation: Add a brief sentence + links:

```
"These are AI coding assistants that Agendo orchestrates.
Install at least one: Claude (npm i -g @anthropic-ai/claude-code),
Codex (npm i -g @openai/codex), or Gemini (npm i -g @google/gemini-cli)."
```

#### Gap 3: Board page has no empty state

The Kanban board (most likely `/board` or `/workspace`) is where users land from step 3, but there's no inline guidance on how to create a task if the board is empty. The projects page has a dashed-border empty state ("No projects yet") but the board may just show empty columns.

Recommendation: Add an `EmptyState` (the reusable component already exists at `src/components/ui/empty-state.tsx`) to the board with a "Create your first task" CTA button.

#### Gap 4: No graceful degradation for missing DB

If PostgreSQL isn't running when the user opens the app, they get an unhandled error. The setup script checks for `pg_isready` but the app itself doesn't show a friendly "Database not connected" page.

Recommendation (low priority): A middleware or root error boundary that catches DB connection errors and shows a static HTML page with setup instructions.

### Text Mockup — Enhanced WelcomeCard

```
+---------------------------------------------------------------+
|                                                                 |
|           Welcome to Agendo                                     |
|  Your self-hosted dashboard for managing AI coding agents.      |
|                                                                 |
|  [check] 1. Agent CLIs          3 agents discovered             |
|  [check] 2. Create a project    1 project linked                |
|  [ 3 ]   3. Create your first task                              |
|           Open the Kanban board and add a task     [->]         |
|                                                                 |
|  -------- Quick actions --------                                |
|  [+ New Project]  [+ New Task]  [Run Discovery]                |
|                                                                 |
+---------------------------------------------------------------+
```

Addition: A "Quick actions" row at the bottom provides direct CTAs without navigating away. Avoids dead-end feeling.

---

## 3. README Improvements

### Current Strengths

- Clean structure with badges, screenshots, architecture diagram
- `setup.sh` handles everything — great for onboarding
- Prerequisites table is clear
- Tech stack table is scannable

### Recommended Changes

#### 3a. Add a "30-Second Start" Section at the Very Top

Most people skim. Put the absolute minimum above the fold:

````markdown
## 30-Second Start

```bash
git clone https://github.com/NehoraiHadad/agendo.git && cd agendo
./scripts/setup.sh --dev
pnpm dev:all  # starts app + worker + terminal
```
````

Open http://localhost:4100

````

This replaces nothing — it goes *above* the existing Quick Start as a TL;DR.

#### 3b. Add Windows/WSL Section

Agendo uses `node-pty` (native addon), PM2, and shell scripts — none of which work natively on Windows. Add:

```markdown
## Windows

Agendo requires a Unix-like environment. On Windows, use WSL 2:

1. Install WSL 2: `wsl --install` (PowerShell admin)
2. Open your WSL terminal (Ubuntu recommended)
3. Install Node.js 22+ inside WSL: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
4. Install pnpm: `npm install -g pnpm`
5. Follow the Quick Start above (inside WSL)

Docker Desktop must have WSL 2 integration enabled for PostgreSQL.
````

#### 3c. Development Mode Section Needs `dev:all`

Currently shows two terminals. After implementing `dev:all`:

````markdown
### Development Mode

```bash
./scripts/setup.sh --dev
pnpm dev:all                    # app + worker + terminal in one terminal
```
````

Or run services separately:

```bash
pnpm dev          # Next.js (port 4100)
pnpm worker:dev   # Worker with hot-reload
pnpm tsx src/terminal/server.ts  # Terminal server (port 4101, optional)
```

````

#### 3d. Add "Contributing" Section

```markdown
## Contributing

1. Fork the repo, clone, and run `./scripts/setup.sh --dev`
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make changes — lint and type-check pass: `pnpm lint && pnpm typecheck`
4. Run tests: `pnpm test`
5. Open a PR against `main`

See CLAUDE.md for architecture details, coding conventions, and the TDD workflow.
````

#### 3e. Remove/Clarify "Start" Section Ambiguity

The current "Start" section shows `pnpm start & node dist/worker/index.js &` which:

- Runs both in background with `&` — logs disappear
- Doesn't mention the terminal server
- Mixes foreground and PM2 options in the same block

Recommendation: Lead with PM2 (the recommended path) and put the raw foreground commands in a "Manual" details block.

---

## 4. Developer Ergonomics

### 4a. Hot Reload Status

| Component       | Hot Reload? | Mechanism        | Notes                                                                                 |
| --------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------- |
| Next.js app     | Yes         | Built-in HMR     | Works out of the box                                                                  |
| Worker          | Yes         | `tsx watch`      | `pnpm worker:dev` uses `tsx watch src/worker/index.ts` — restarts on any `.ts` change |
| Terminal server | **No**      | Manual restart   | Must kill and restart `tsx src/terminal/server.ts`. No watch script defined           |
| MCP server      | **No**      | Requires rebuild | `pnpm build:mcp` then restart worker                                                  |

**Recommendation:** Add `"terminal:dev": "tsx watch src/terminal/server.ts"` for terminal hot-reload. The MCP server rebuild is acceptable since it changes rarely.

### 4b. Common Gotchas for New Contributors

1. **Port 4100 is mandatory** — Port 3000 is taken by another app on the reference server. The README mentions 4100 but `next dev` defaults to 3000 if `PORT` isn't set. The script uses `--port ${PORT:-4100}` which handles it, but running `npx next dev` directly will use 3000.

2. **Worker reads env from ecosystem.config.js, not .env.local** — This is a production-only concern (dev mode uses `tsx` which inherits shell env), but the mismatch has caused bugs. Worth a callout box in the README.

3. **`params` is async in Next.js 16** — `const { id } = await params;` is required. TypeScript catches this, but it's unintuitive for devs coming from Next.js 14/15.

4. **`node-pty` requires build tools** — On fresh Ubuntu: `sudo apt install build-essential python3`. On macOS: Xcode CLI tools. The setup script doesn't check for this, and `pnpm install` will fail with a cryptic error.

5. **esbuild for worker, not tsc** — `tsc` OOMs on this server. New contributors might try `tsc` instinctively.

6. **Never run `pnpm dev` under PM2** — And never run PM2 commands in dev mode. These two worlds should not mix.

7. **Husky + lint-staged** — Pre-commit hooks run ESLint + Prettier. Contributors with `--no-verify` habits will get CI failures.

### 4c. Missing Dev Conveniences

| Feature                   | Status     | Recommendation                                               |
| ------------------------- | ---------- | ------------------------------------------------------------ |
| `dev:all` single command  | Missing    | Add with `concurrently` (see section 1)                      |
| `terminal:dev` watch mode | Missing    | Add `tsx watch` script                                       |
| Database reset command    | Missing    | Add `"db:reset": "drizzle-kit push --force && pnpm db:seed"` |
| Storybook                 | Not set up | Not needed yet — components are simple enough                |
| E2E tests                 | Not set up | Playwright would be valuable for session flows (future)      |

---

## 5. Prioritized Action Items

### P0 — Do First (High Impact, Low Effort)

| #   | Item                                                         | Effort | Impact                               |
| --- | ------------------------------------------------------------ | ------ | ------------------------------------ |
| 1   | Add `concurrently` + `pnpm dev:all` script                   | 15 min | Eliminates 3-terminal friction       |
| 2   | Add `terminal:dev` watch script                              | 5 min  | Completes hot-reload story           |
| 3   | Update README with `dev:all`, 30-second start                | 30 min | First impression for GitHub visitors |
| 4   | Fix WelcomeCard step 2 `done` prop to use real project count | 15 min | Onboarding feels alive               |

### P1 — Do Soon (Medium Impact)

| #   | Item                                                | Effort | Impact                               |
| --- | --------------------------------------------------- | ------ | ------------------------------------ |
| 5   | Add Windows/WSL section to README                   | 20 min | Unblocks Windows users               |
| 6   | Add `node-pty` build-tools check to `setup.sh`      | 15 min | Prevents cryptic install failure     |
| 7   | Add Contributing section to README                  | 15 min | Encourages open-source contributions |
| 8   | Add empty state to Kanban board when no tasks exist | 30 min | Completes onboarding flow            |
| 9   | Enhance WelcomeCard agent step with install links   | 20 min | Guides users who don't have CLIs yet |

### P2 — Nice to Have (Lower Priority)

| #   | Item                                           | Effort | Impact                              |
| --- | ---------------------------------------------- | ------ | ----------------------------------- |
| 10  | Add `db:reset` convenience script              | 5 min  | Useful for dev iteration            |
| 11  | Add "Quick actions" row to WelcomeCard         | 45 min | Reduces navigation for new users    |
| 12  | Add DB connection error boundary               | 2 hr   | Graceful failure when PG is down    |
| 13  | Add GIF/video demo to README                   | 1 hr   | Better GitHub first impression      |
| 14  | Restructure README "Start" section (PM2-first) | 20 min | Less confusing for production users |

---

## Appendix: Files Reviewed

| File                                          | Key Observations                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `package.json`                                | 24 scripts, no `dev:all` or `terminal:dev`. Has `worker:dev` with tsx watch.               |
| `README.md`                                   | Good structure, missing Windows/WSL, no contributing guide, dev mode requires 2+ terminals |
| `setup.sh`                                    | Comprehensive (env, docker, build, schema, seed). Missing build-tools check for node-pty   |
| `.env.example`                                | Well-documented with sections. 22 variables, only 2 required                               |
| `ecosystem.config.example.js`                 | Good comments explaining each service. Loads .env.local via dotenv                         |
| `docker-compose.yml`                          | Simple, correct. PG 17 Alpine with healthcheck                                             |
| `src/app/(dashboard)/page.tsx`                | Has `isEmpty` check + WelcomeCard — good foundation                                        |
| `src/components/dashboard/welcome-card.tsx`   | 3-step onboarding. Steps 2-3 hardcoded `done={false}`                                      |
| `src/components/ui/empty-state.tsx`           | Reusable component with icon/title/description/action — underused                          |
| `src/components/projects/projects-client.tsx` | Has dashed-border empty state — good                                                       |
| `src/app/(dashboard)/agents/page.tsx`         | Has empty state with discovery CTA — good                                                  |
| `src/app/(dashboard)/workspace/page.tsx`      | Has empty state + NewWorkspaceCard — good                                                  |
| `src/lib/db/seed.ts`                          | Seeds worker config + discovers agents. Clear output messaging                             |
