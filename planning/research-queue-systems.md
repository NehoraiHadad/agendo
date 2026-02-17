# Job Queue Research for Agent Monitor

**Date:** 2026-02-17
**Context:** Node.js project spawning CLI processes (git commands, AI agent sessions). Jobs run seconds to 30+ minutes. Max 3 concurrent. Currently planning raw Postgres with `FOR UPDATE SKIP LOCKED`.

---

## TL;DR Recommendation

**Use pg-boss.** It wraps your planned `FOR UPDATE SKIP LOCKED` pattern in a battle-tested library, adds retry logic, expiration, dead letter queues, and concurrency control -- all without adding Redis or RabbitMQ. For your scale (max 3 concurrent jobs, low throughput), raw Postgres polling would also work, but pg-boss costs you almost nothing in complexity while saving you from reimplementing solved problems.

Redis/RabbitMQ would add complexity without meaningful benefit at your scale.

---

## 1. Postgres-as-Queue in Production

### How It Works

`FOR UPDATE SKIP LOCKED` (Postgres 9.5+) lets workers atomically claim jobs without blocking each other. A worker runs:

```sql
UPDATE jobs SET status = 'active', locked_by = $1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

The lock is tied to the transaction -- if a worker crashes, the lock releases automatically.

### Who Uses This Pattern Successfully

| Project                           | Scale                                              | Notes                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **37signals / HEY** (Solid Queue) | 20M jobs/day, 800 workers, 74 VMs                  | Replaced Redis-based Resque. Main benefit: "simplicity and ease of operation" ([source](https://dev.37signals.com/introducing-solid-queue/))                   |
| **Hatchet**                       | 20k+ tasks/minute                                  | Built entirely on Postgres. "Postgres solves for 99.9% of queueing use-cases better than most alternatives" ([source](https://github.com/hatchet-dev/hatchet)) |
| **Inferable**                     | Hundreds of machines, thousands of concurrent jobs | Uses SKIP LOCKED for distributed work across long-polling workers ([source](https://www.inferable.ai/blog/posts/postgres-skip-locked))                         |

### Performance Numbers

- **Graphile Worker benchmarks:** 99,600 jobs queued/sec, 11,800 processed/sec on a 12-core DB server. Average latency: under 3ms ([source](https://worker.graphile.org/docs))
- **37signals Solid Queue:** 1,300 polling queries/sec with 110 microsecond average query time ([source](https://dev.37signals.com/introducing-solid-queue/))
- **PGMQ (Tembo):** 30,000+ messages/sec on 1vCPU/4GB ([source](https://legacy.tembo.io/blog/mq-stack-benchmarking/))

**For Agent Monitor's scale (a few jobs per minute, max 3 concurrent), Postgres is wildly overprovisioned.**

### Real Gotchas and Failure Modes

**1. MVCC Bloat (the big one)**

Postgres doesn't immediately delete rows -- it marks them as dead tuples for VACUUM to clean later. Job queue tables have extremely high churn (constant insert/update/delete), creating pathological conditions:

- Dead tuples accumulate in the jobs table
- Index scans must skip over thousands of invisible rows
- Worker lock times can increase 15x during degradation
- At ~50 jobs/sec sustained churn, degradation can become unrecoverable in ~15 minutes without intervention

**Source:** Brandur Leach's detailed analysis at [brandur.org/postgres-queues](https://brandur.org/postgres-queues)

**2. Long-Running Transactions Block VACUUM**

This hit Trigger.dev in production (August 2024): their Graphile Worker table accumulated 600,000 dead tuples because a stuck transaction prevented vacuuming. CPU spiked to 95-99% for 6 hours. They had to failover to a replica to recover. ([source](https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming))

**3. Mitigations**

- Tune autovacuum aggressively for the jobs table (lower `autovacuum_vacuum_scale_factor`)
- Delete completed jobs promptly (Graphile Worker does this automatically)
- Monitor dead tuple counts (use pg_stat_user_tables)
- Keep the "hot" table small -- isolate job states into separate tables (Solid Queue's approach)
- Avoid long-running transactions on the same database

**For Agent Monitor:** At your volume (a few jobs/minute), MVCC bloat is a non-issue. You would need sustained hundreds of jobs/sec to trigger these problems. However, your jobs themselves run for 30+ minutes -- make sure the job _lock_ is not held as a long-running transaction. pg-boss handles this correctly by marking jobs as "active" and releasing the transaction, then using a separate expiration check.

---

## 2. BullMQ (Redis-Based)

### What Redis Adds That Postgres Cannot

| Feature               | BullMQ (Redis)        | Postgres Queue                             |
| --------------------- | --------------------- | ------------------------------------------ |
| Pub/sub notifications | Native, sub-ms        | LISTEN/NOTIFY (good but Postgres-specific) |
| Rate limiting         | Built-in, per-queue   | Must implement yourself                    |
| Priority queues       | Built-in              | Possible with SQL ORDER BY                 |
| Job progress tracking | Built-in              | Must implement yourself                    |
| Dashboard UI          | Bull Board (official) | No standard option                         |
| Real-time events      | Native Redis pub/sub  | Possible but more work                     |
| Throughput ceiling    | 100k+ jobs/sec        | 10k+ jobs/sec (still plenty)               |

### When BullMQ Makes Sense

- You already run Redis for caching/sessions
- You need real-time job progress events (progress bars, live dashboards)
- You need sophisticated rate limiting across distributed workers
- You're processing 10,000+ jobs/sec
- You want the Bull Board UI out of the box

### When It Does NOT Make Sense

- You're adding Redis solely for the queue (n8n requires this and it's a common complaint)
- Your jobs are low-volume (< 100/min)
- You need transactional job creation (create job + update data atomically)
- You're a small team trying to minimize infrastructure

### Memory Overhead

Redis memory scales linearly with job payload size. For reference:

- 4.5M delayed jobs + 45K repeating jobs consumed ~10GB in one production case ([source](https://github.com/taskforcesh/bullmq/issues/2734))
- For Agent Monitor's scale (dozens of jobs), Redis overhead would be negligible (< 50MB)
- BullMQ docs recommend a dedicated Redis instance, not shared with caching ([source](https://docs.bullmq.io/guide/going-to-production))

**Verdict for Agent Monitor:** BullMQ would work fine, but adding Redis for 3 concurrent jobs is over-engineering. You'd be running a Redis server 24/7 to manage a queue that rarely has more than 3 items in it.

---

## 3. Existing Libraries vs Raw SQL

### pg-boss -- The Recommendation

[GitHub](https://github.com/timgit/pg-boss) | 3,100+ stars | 96K weekly downloads

pg-boss wraps `FOR UPDATE SKIP LOCKED` and adds everything you'd otherwise build yourself:

```typescript
import PgBoss from 'pg-boss';

const boss = new PgBoss(DATABASE_URL);
await boss.start();

// Send a job with 30-minute timeout
await boss.send(
  'agent-session',
  { repoUrl, prompt },
  {
    expireInMinutes: 45, // Auto-fail if still running after 45 min
    retryLimit: 2, // Retry twice on failure
    retryDelay: 30, // Wait 30 seconds between retries
  },
);

// Process with concurrency limit of 3
await boss.work('agent-session', { teamSize: 3 }, async (job) => {
  // Spawn your CLI process here
  const result = await spawnAgentSession(job.data);
  return result;
});
```

**What pg-boss gives you over raw SQL:**

- Job expiration (critical for your 30-minute jobs -- `expireInMinutes: 45`)
- Dead letter queues (failed jobs go somewhere you can inspect)
- Automatic retries with exponential backoff
- Cron scheduling (if you ever need periodic tasks)
- Concurrency control via `teamSize`
- Automatic schema management (creates its own tables)
- Completion/failure callbacks
- Job deduplication (singleton jobs)

**What it does NOT do:**

- No built-in UI/dashboard (you'd query the tables directly)
- No per-user concurrency limits (you'd implement this yourself)
- Concurrency is per-instance, not global across instances (fine for single-server Agent Monitor)

### Graphile Worker -- The Alternative

[GitHub](https://github.com/graphile/worker) | 2,100 stars | 42K weekly downloads

More "Postgres-native" -- you define tasks in SQL or JS, and it uses `LISTEN/NOTIFY` for sub-3ms latency.

**Pros over pg-boss:**

- Lower latency (LISTEN/NOTIFY vs polling)
- Can run in-process (same Node.js process as your app)
- Built by the PostGraphile team, deeply Postgres-optimized
- AbortSignal support for graceful shutdown of long-running tasks ([source](https://worker.graphile.org/docs/tasks))
- Auto-deletes completed jobs (prevents table bloat)

**Cons:**

- Fewer downloads and smaller community than pg-boss
- No built-in debouncing or singleton jobs
- API is more Postgres-centric (less familiar for JS devs)
- 0.x versioning (though used in production by Trigger.dev and others)
- 4-hour lock timeout on crashed workers (vs configurable in pg-boss)

### PGMQ (Tembo)

A Postgres extension (Rust-based), not a Node.js library. Best for teams that want SQS-like semantics purely in SQL. Less relevant for Node.js projects since you'd still need a Node.js wrapper.

### Comparison Table

| Feature                  | Raw SQL | pg-boss           | Graphile Worker      |
| ------------------------ | ------- | ----------------- | -------------------- |
| Setup effort             | High    | Low               | Low                  |
| Retry logic              | DIY     | Built-in          | Built-in             |
| Job expiration           | DIY     | Built-in          | 4hr default          |
| Concurrency control      | DIY     | `teamSize`        | `concurrency` option |
| Long-running job support | DIY     | `expireInMinutes` | AbortSignal          |
| Cron/recurring jobs      | DIY     | Built-in          | Built-in             |
| Dead letter queue        | DIY     | Built-in          | Manual               |
| Node.js ecosystem fit    | N/A     | Excellent         | Good                 |
| Schema management        | DIY     | Automatic         | Automatic            |
| Notification mechanism   | Polling | Polling           | LISTEN/NOTIFY        |

**Maturity verdict:** Both pg-boss and Graphile Worker are production-ready. pg-boss has been around since 2016 with broader adoption. Graphile Worker is newer but used by Trigger.dev in production.

---

## 4. What Real Projects Use

### Trigger.dev (task orchestration for developers)

- **Primary queue:** Redis (for v3/v4 run queue -- high throughput, low latency)
- **Internal async tasks:** Graphile Worker on Postgres (scheduled tasks, alert emails)
- **Self-hosted v4:** Ships with Postgres + Redis + object storage
- **Notable incident:** Graphile Worker table bloat caused 6-hour CPU spike; had to failover to replica ([source](https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming))

### Hatchet (distributed task queue)

- **Queue:** 100% Postgres-based using SKIP LOCKED
- **Scale:** 20k+ tasks/minute, each task = 5+ Postgres transactions
- **v1 tagline:** "A task orchestration platform built on Postgres"
- **Optional:** RabbitMQ for inter-service communication in high-throughput self-hosted deployments
- **Key optimizations:** Range partitioning, hash partitioning, separated monitoring tables, buffered reads/writes ([source](https://docs.hatchet.run/home/architecture))

### n8n (workflow automation)

- **Queue:** BullMQ (Redis-based) in queue mode
- **Why Redis:** Needed to separate main process (UI/API) from worker processes
- **Requirement:** Queue mode mandates PostgreSQL (for data) + Redis (for jobs)
- **Community feedback:** Adding Redis is a common pain point for self-hosters ([source](https://docs.n8n.io/hosting/scaling/queue-mode/))

### Cal.com (scheduling)

- Could not confirm specific queue technology from public sources. Their codebase references suggest they may use a lightweight approach given their primarily synchronous webhook-driven architecture.

### 37signals / HEY (email) -- Ruby, but instructive

- **Queue:** Solid Queue (Postgres-based, SKIP LOCKED)
- **Scale:** 20M jobs/day, 800 workers
- **Key lesson:** "Having everything stored in a relational DB made debugging significantly easier compared to troubleshooting issues with Resque [Redis]" ([source](https://dev.37signals.com/introducing-solid-queue/))

---

## 5. Specific Recommendation for Agent Monitor

### Your Use Case Profile

- **Job types:** Spawning CLI processes (git, AI agents)
- **Duration:** Seconds to 30+ minutes
- **Concurrency:** Max 3
- **Throughput:** Low (likely < 10 jobs/minute)
- **Infrastructure:** Single server, Postgres already planned
- **Team size:** Solo / small

### Is a Queue Library Even Needed?

Raw Postgres polling (your current plan) would technically work. A simple loop:

```typescript
// Poll every 5 seconds
setInterval(async () => {
  if (activeJobs >= 3) return;

  const job = await db.query(`
    UPDATE jobs SET status = 'active', started_at = NOW()
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'pending'
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING *
  `);

  if (job) spawnProcess(job);
}, 5000);
```

**But you'd quickly need to add:**

1. Job expiration (what if a process hangs for 2 hours?)
2. Retry logic (what if git clone fails transiently?)
3. Failure tracking (where do failed jobs go?)
4. Graceful shutdown (SIGTERM while a job is running)
5. Completed job cleanup (table bloat over months)

That's 200-400 lines of careful code. pg-boss gives you all of it for free.

### The Recommendation

```
+--------------------------------------------------+
|  Use pg-boss on your existing Postgres            |
|                                                    |
|  - Zero new infrastructure                         |
|  - Built-in expiration for long-running jobs       |
|  - Built-in retry + dead letter queue              |
|  - teamSize: 3 for concurrency control             |
|  - Battle-tested SKIP LOCKED under the hood        |
|  - ~2KB added to your node_modules                 |
+--------------------------------------------------+
```

### What NOT to Do

- **Don't add Redis** just for a queue. You'd run a Redis server 24/7 to manage 3 concurrent jobs. The operational cost (memory, monitoring, backups, restarts) outweighs any benefit.
- **Don't add RabbitMQ.** It's designed for high-throughput message routing between services. You have one service.
- **Don't write raw SQL queue logic.** You'll reinvent pg-boss poorly and maintain it forever.
- **Don't use Graphile Worker** unless you specifically want LISTEN/NOTIFY for sub-3ms job pickup. For jobs that run 30 minutes, a 5-second polling delay is irrelevant.

### When You'd Reconsider

You should revisit this decision if:

1. **You add a second server** and need distributed workers -- pg-boss handles this, but you'd need to test cross-instance concurrency limits
2. **You need real-time progress** (live streaming of agent output) -- that's a websocket concern, not a queue concern
3. **You exceed 1,000 jobs/minute sustained** -- at that point, dedicated Redis queue benchmarks better, but you're likely years from this
4. **You need complex routing** (priority lanes, rate limiting per user) -- BullMQ excels here, but pg-boss covers basic priority

### Minimal pg-boss Integration

```typescript
// queue.ts
import PgBoss from 'pg-boss';

const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  retryLimit: 2,
  retryDelay: 30,
  expireInMinutes: 45, // Safety net for hung processes
});

await boss.start();

// Register worker with max 3 concurrent
await boss.work('spawn-agent', { teamSize: 3 }, async (job) => {
  const { command, args, timeout } = job.data;

  const proc = spawn(command, args);

  // Update job progress (optional)
  await boss.send('job-progress', {
    jobId: job.id,
    status: 'running',
    pid: proc.pid,
  });

  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) resolve({ exitCode: code });
      else reject(new Error(`Process exited with code ${code}`));
    });
  });
});

// Enqueue a job
await boss.send('spawn-agent', {
  command: 'node',
  args: ['./agent-runner.js', '--repo', repoUrl],
  timeout: 1800000, // 30 min
});
```

---

## Summary Decision Matrix

| Factor                            | Raw Postgres      | pg-boss  | BullMQ             | RabbitMQ            |
| --------------------------------- | ----------------- | -------- | ------------------ | ------------------- |
| New infrastructure                | None              | None     | Redis server       | RabbitMQ server     |
| Setup time                        | 2-4 hours         | 30 min   | 1-2 hours          | 2-4 hours           |
| Maintenance burden                | High (DIY)        | Low      | Medium (Redis ops) | High (RabbitMQ ops) |
| Long-running job support          | DIY               | Built-in | Built-in           | Built-in            |
| Right-sized for 3 concurrent jobs | Yes               | **Yes**  | Overkill           | Overkill            |
| Community/docs                    | N/A               | Good     | Excellent          | Excellent           |
| Risk of outgrowing                | Low at your scale | Low      | Very low           | Very low            |

**Final answer: pg-boss. Ship it and move on.**

---

## Sources

- [Postgres Job Queues & Failure By MVCC](https://brandur.org/postgres-queues) -- Brandur Leach's deep dive on MVCC bloat
- [The Unreasonable Effectiveness of SKIP LOCKED](https://www.inferable.ai/blog/posts/postgres-skip-locked) -- Inferable's production experience
- [Introducing Solid Queue](https://dev.37signals.com/introducing-solid-queue/) -- 37signals on running 20M jobs/day on Postgres
- [pg-boss GitHub](https://github.com/timgit/pg-boss) -- Node.js Postgres job queue
- [Graphile Worker](https://worker.graphile.org/) -- High-performance Postgres job queue
- [PGMQ by Tembo](https://github.com/pgmq/pgmq) -- Postgres extension for message queuing
- [BullMQ](https://docs.bullmq.io) -- Redis-based job queue for Node.js
- [Hatchet Architecture](https://docs.hatchet.run/home/architecture) -- Postgres-based task orchestration
- [Trigger.dev MVCC Blog Post](https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming) -- Production incident with Postgres vacuum blocking
- [n8n Queue Mode](https://docs.n8n.io/hosting/scaling/queue-mode/) -- n8n's BullMQ/Redis architecture
- [Hatchet HN Discussion](https://news.ycombinator.com/item?id=39643136) -- Community debate on Postgres vs Redis queues
- [PostgreSQL SKIP LOCKED Pattern](https://medium.com/@the_atomic_architect/postgresql-replaced-my-message-queue-and-taught-me-skip-locked-along-the-way-87d59e5b9525) -- Benchmarks showing Postgres beating RabbitMQ by 38%
- [pg-boss Concurrency Discussion](https://github.com/timgit/pg-boss/issues/429) -- teamSize and concurrency limits
- [Graphile Worker AbortSignal](https://worker.graphile.org/docs/tasks) -- Graceful shutdown for long-running tasks
