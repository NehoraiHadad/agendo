# PostgreSQL vs MongoDB for Agent Monitor

**Research Date:** 2026-02-17
**Context:** Personal task management system for CLI agents (git, docker, Claude AI, Gemini AI). 8 relational tables, DAG task dependencies, job queue with atomic claim, audit trail. Scale: <1000 tasks.

---

## 1. What Databases Do Successful Task/Job Queue Projects Use?

### Summary Table

| Project             | Type                          | Database                            | License     | Notes                                                                                                                 |
| ------------------- | ----------------------------- | ----------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| **Linear**          | Project management            | PostgreSQL (Cloud SQL)              | Proprietary | [GCP blog](https://cloud.google.com/blog/products/databases/product-workflow-tool-linear-uses-google-cloud-databases) |
| **Plane.so**        | Project management (Jira alt) | PostgreSQL                          | Open source | [Self-host docs](https://developers.plane.so/self-hosting/methods/docker-compose)                                     |
| **Hatchet**         | Task orchestrator             | PostgreSQL                          | MIT         | [GitHub](https://github.com/hatchet-dev/hatchet-v1)                                                                   |
| **Trigger.dev**     | Background jobs               | PostgreSQL + ClickHouse (analytics) | Apache 2.0  | [GitHub](https://github.com/triggerdotdev/trigger.dev)                                                                |
| **Graphile Worker** | Job queue                     | PostgreSQL                          | MIT         | [Docs](https://worker.graphile.org/)                                                                                  |
| **BullMQ**          | Job queue                     | Redis                               | MIT         | [Docs](https://docs.bullmq.io/guide/architecture)                                                                     |
| **Oban** (Elixir)   | Job queue                     | PostgreSQL                          | Apache 2.0  | Uses SKIP LOCKED                                                                                                      |
| **Que** (Ruby)      | Job queue                     | PostgreSQL                          | MIT         | Uses SKIP LOCKED                                                                                                      |

**Key finding: Every task management / project management tool in this list uses PostgreSQL. Zero use MongoDB.** The only non-Postgres option is BullMQ, which uses Redis (a fundamentally different tradeoff -- pure in-memory speed, no relational modeling).

### Linear (proprietary, the gold standard)

- Full stack: Node.js, TypeScript, GraphQL, PostgreSQL, Redis
- Uses Cloud SQL for PostgreSQL on Google Cloud
- Uses pgvector for similarity search features
- Scales to "tens of terabytes" on managed PostgreSQL
- Source: [Linear Tech Stack (Himalayas)](https://himalayas.app/companies/linear/tech-stack), [Linear multi-region blog](https://linear.app/now/how-we-built-multi-region-support-for-linear)

### Plane.so (open-source Jira alternative)

- PostgreSQL as primary database, Redis for caching, MinIO for object storage
- Docker Compose setup with `plane-db` (PostgreSQL) container
- Database URL format: `postgresql://plane:plane@plane-db:5432/plane`
- Source: [Plane self-hosting docs](https://developers.plane.so/self-hosting/methods/docker-compose)

### Hatchet (task orchestrator, YC W24)

Built entirely on PostgreSQL. Their detailed reasoning:

> "We feel quite strongly that Postgres solves for 99.9% of queueing use-cases better than most alternatives."

Technical details:

- Each task = minimum 5 Postgres transactions
- Handles bursts of 5k+ tasks/second (25k TPS)
- Uses `FOR UPDATE SKIP LOCKED` for job claiming
- Upgraded to range-based partitioning and hash-based partitioning at scale
- **Zero MongoDB consideration** -- all architecture discussions assume PostgreSQL
- Source: [HN discussion](https://news.ycombinator.com/item?id=43572733), [GitHub](https://github.com/hatchet-dev/hatchet-v1)

### Trigger.dev

- PostgreSQL (via Prisma ORM) for primary data
- ClickHouse for analytics/observability
- Redis for caching
- Uses `internal-packages/database/prisma/schema.prisma` for schema
- Source: [GitHub contributing guide](https://github.com/triggerdotdev/trigger.dev/blob/main/CONTRIBUTING.md)

### Graphile Worker (PostgreSQL-native job queue)

- Pure PostgreSQL, no other dependencies
- Uses `SKIP LOCKED` for job fetching
- Uses `LISTEN/NOTIFY` for sub-3ms job pickup latency
- Benchmarks: ~99,600 jobs/sec enqueue, ~11,800 jobs/sec processing (12-core DB)
- Source: [Graphile Worker docs](https://worker.graphile.org/docs)

### Nango (migrated FROM Temporal TO PostgreSQL)

Relevant case study. Nango built a custom Postgres-based orchestrator in ~300 lines of TypeScript:

- Used `SELECT ... FOR UPDATE SKIP LOCKED` for atomic task claiming
- Migrated millions of production tasks with zero downtime
- Temporal was "a pretty expensive and complex queuing and scheduling system"
- Source: [Nango blog](https://nango.dev/blog/migrating-from-temporal-to-a-postgres-based-task-orchestrator)

---

## 2. MongoDB for DAG/Graph Structures

### $graphLookup: The MongoDB Approach

MongoDB provides `$graphLookup` as an aggregation stage for recursive graph traversal. It works but has significant limitations:

**How it works:**

```javascript
db.tasks.aggregate([
  {
    $graphLookup: {
      from: 'tasks',
      startWith: '$dependencies',
      connectFromField: 'dependencies',
      connectToField: '_id',
      as: 'allDependencies',
      maxDepth: 10,
    },
  },
]);
```

**Hard limitations:**

1. **100MB memory cap** -- `$graphLookup` cannot spill to disk (`allowDiskUse` is ignored for this stage). Complex DAGs with many nodes will fail.
2. **16MB document size limit** -- all traversed results must fit in a single output document
3. **No result ordering** -- results come back unordered; no built-in topological sort
4. **No cycle detection** -- you must handle DAG validation in application code
5. **Multi-parent complexity** -- traversal across multiple branches requires careful handling to avoid duplicates
6. **Single-collection only** -- cannot traverse relationships spanning multiple collections

Source: [MongoDB $graphLookup docs](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/)

### PostgreSQL: Recursive CTEs for DAGs

PostgreSQL handles DAGs natively with recursive CTEs:

```sql
-- Schema: task_dependencies(task_id, depends_on_id)

-- Get all dependencies of a task (transitive closure)
WITH RECURSIVE deps(task_id, depth) AS (
    SELECT depends_on_id, 1
    FROM task_dependencies
    WHERE task_id = $1
    UNION ALL
    SELECT td.depends_on_id, d.depth + 1
    FROM task_dependencies td
    JOIN deps d ON td.task_id = d.task_id
)
SELECT * FROM deps;

-- Topological sort of entire DAG
WITH RECURSIVE traverse(id, depth) AS (
    SELECT id, 1 FROM tasks
    WHERE id NOT IN (SELECT task_id FROM task_dependencies)
    UNION ALL
    SELECT td.task_id, t.depth + 1
    FROM task_dependencies td
    JOIN traverse t ON td.depends_on_id = t.id
)
SELECT id FROM traverse
GROUP BY id
ORDER BY MAX(depth);
```

**Advantages over $graphLookup:**

- No memory cap (uses disk for large results)
- Native ordering with `ORDER BY`
- Cycle detection with `CYCLE` clause (PostgreSQL 14+)
- Can join across any tables
- Topological sort in pure SQL

Source: [Fusionbox blog on recursive CTEs](https://www.fusionbox.com/blog/detail/graph-algorithms-in-a-database-recursive-ctes-and-topological-sort-with-postgres/620/)

### Verdict: DAGs

**PostgreSQL is clearly superior for DAG operations.** Recursive CTEs are a first-class feature with no artificial memory limits. MongoDB's `$graphLookup` works for simple hierarchies but becomes painful for real DAG operations (topological sort, cycle detection, dependency resolution).

---

## 3. Job Queue: FOR UPDATE SKIP LOCKED vs MongoDB Equivalents

### PostgreSQL: FOR UPDATE SKIP LOCKED

The canonical pattern for atomic job claiming:

```sql
BEGIN;

-- Atomically claim the next available job
-- Other workers skip this row, no blocking, no deadlocks
SELECT * FROM task_executions
WHERE status = 'queued'
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;

-- Claim it
UPDATE task_executions
SET status = 'running',
    claimed_by = 'worker-1',
    started_at = NOW()
WHERE id = $claimed_id;

COMMIT;
```

**Properties:**

- Truly atomic: claim + read in one transaction
- No race conditions by design
- No double-processing
- No deadlocks (SKIP LOCKED avoids them)
- Failed transactions auto-release locks
- Battle-tested in Graphile Worker, Oban, Que, Hatchet, Nango
- Source: [DB Pro blog](https://www.dbpro.app/blog/postgresql-skip-locked)

### MongoDB: findOneAndUpdate Pattern

```javascript
const job = await db.collection('jobs').findOneAndUpdate(
  { status: 'queued' },
  {
    $set: {
      status: 'running',
      claimedBy: 'worker-1',
      startedAt: new Date(),
    },
  },
  {
    sort: { priority: -1, createdAt: 1 },
    returnDocument: 'after',
  },
);
```

**Properties:**

- Atomic at the single-document level
- Document-level lock during operation
- Returns the modified document
- **No SKIP LOCKED equivalent** -- if two workers query simultaneously, one will update and one will get null (no match), requiring retry logic
- No multi-document transaction guarantee without replica set
- Source: [MongoDB findAndModify docs](https://www.mongodb.com/docs/manual/reference/command/findandmodify/), [MongoDB Job Queue Crisis (Medium)](https://medium.com/@khaledosama52/mongodb-job-queue-crisis-8280b563c8f3)

### Key Difference

| Feature                 | PostgreSQL SKIP LOCKED              | MongoDB findOneAndUpdate                                         |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Atomicity               | Transaction-level (multi-row)       | Single-document only                                             |
| Concurrent workers      | Each gets a different row instantly | One succeeds, others get null + retry                            |
| Ordering guarantee      | Yes, with ORDER BY                  | Yes, with sort                                                   |
| Deadlock risk           | None (SKIP LOCKED prevents it)      | None (single-doc lock)                                           |
| Multi-step claim+update | Single transaction                  | Requires separate operations or transactions (needs replica set) |
| Ecosystem maturity      | 5+ production job queue libraries   | DIY pattern, no major library                                    |

### Verdict: Job Queue

**PostgreSQL wins decisively.** `FOR UPDATE SKIP LOCKED` is purpose-built for job queues. MongoDB's `findOneAndUpdate` works but lacks the elegance of SKIP LOCKED for multi-worker scenarios and requires a replica set for multi-document transactions.

---

## 4. Real-World Migration Stories

### Infisical: MongoDB -> PostgreSQL

Infisical (secrets management platform) migrated their entire platform from MongoDB to PostgreSQL after encountering:

1. **Transaction complexity**: MongoDB requires cluster mode (replica set) for transactions -- impractical for self-hosted deployments
2. **No CASCADE**: Had to build custom deletion logic, resulting in orphaned data
3. **License issues**: MongoDB's SSPL license caused providers to stop offering current versions
4. **Unfamiliarity**: More support burden because users knew SQL, not MongoDB

**Results after migration:**

- 50% database cost reduction (proper JOINs replaced aggregation pipelines)
- Database-level validation replaced app-layer enforcement
- Zero data loss during 3-4 month migration
- Source: [Infisical blog](https://infisical.com/blog/postgresql-migration-technical)

### Tyk API Gateway: MongoDB -> PostgreSQL

Tyk built a dedicated migration tool because enough users demanded PostgreSQL support. Common reasons:

- Existing PostgreSQL infrastructure
- Team familiarity with SQL
- Operational simplicity
- Source: [Tyk blog](https://tyk.io/blog/migrating-to-postgres-from-mongodb-tyks-migration-tool-makes-it-easy/)

### General Trend

Multiple sources document a pattern of MongoDB -> PostgreSQL migrations. I found **zero documented cases** of task management / job queue systems migrating from PostgreSQL to MongoDB.

---

## 5. Drizzle ORM and MongoDB

### Drizzle Does NOT Support MongoDB

Drizzle ORM explicitly does not support MongoDB and has stated it is **out of scope**:

> "If they were to build an ORM for MongoDB, it would be a different library."

Drizzle supports: PostgreSQL, MySQL, SQLite, SingleStore, and serverless variants (Neon, Turso, Supabase).

Source: [Drizzle ORM GitHub issue #2377](https://github.com/drizzle-team/drizzle-orm/issues/2377), [Drizzle ORM GitHub issue #2697](https://github.com/drizzle-team/drizzle-orm/issues/2697)

### If You Chose MongoDB, Your ORM Options Would Be:

| ORM/ODM       | MongoDB Support             | TypeScript | Notes                                                                                                                                                                   |
| ------------- | --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mongoose**  | Native (it's a MongoDB ODM) | Good       | Most mature, but not type-safe by default                                                                                                                               |
| **Prisma**    | Yes (with limitations)      | Excellent  | No Prisma Studio support for Mongo; no auto-relations from introspection; `_id` mapping issues; requires replica set for transactions; v7 MongoDB support "coming soon" |
| **Typegoose** | Yes (Mongoose wrapper)      | Good       | Adds TypeScript decorators to Mongoose                                                                                                                                  |

**Prisma's MongoDB limitations are significant:**

- No Prisma Studio (the GUI tool)
- `_id` fields need `@map` workaround
- Introspection produces schemas with no relations (must add manually)
- Null vs. missing field distinction not supported
- Inconsistent field types across documents cause runtime errors
- Transactions require replica set
- Source: [Prisma MongoDB docs](https://www.prisma.io/docs/orm/overview/databases/mongodb)

### If You Choose PostgreSQL (Drizzle works perfectly):

Drizzle + PostgreSQL gives you:

- Schema-as-TypeScript-code (no separate schema language)
- Full type safety
- ~7.4KB bundle size
- SQL-like query builder and relational query API
- Native migration support
- Works with Neon, Supabase, or plain pg
- Source: [Drizzle ORM docs](https://orm.drizzle.team/docs/overview)

---

## 6. Analysis for Agent Monitor Specifically

### Your Requirements vs Database Fit

| Requirement                                | PostgreSQL                    | MongoDB                                |
| ------------------------------------------ | ----------------------------- | -------------------------------------- |
| 8 relational tables                        | Native (it's a relational DB) | Requires denormalization or $lookup    |
| 1:N relationships (agents -> capabilities) | Foreign keys + JOINs          | Embedded docs or references            |
| DAG dependencies                           | Recursive CTEs (excellent)    | $graphLookup (limited)                 |
| State machine (execution status)           | CHECK constraints + triggers  | Application-level only                 |
| Atomic job claim (SKIP LOCKED)             | Native, battle-tested         | findOneAndUpdate (works, less elegant) |
| Audit trail (task_events)                  | Triggers + INSERT             | Change streams (overkill) or manual    |
| Drizzle ORM                                | Full support                  | Not supported                          |
| Schema enforcement                         | Database-level                | Application-level (Mongoose/Prisma)    |
| Self-hosting simplicity                    | Single binary, no replica set | Needs replica set for transactions     |

### Scale Consideration

At <1000 tasks, **both databases are fast enough**. Performance is not the differentiator. The differentiators are:

1. **Data model fit**: 8 relational tables with foreign keys, JOINs, and constraints = PostgreSQL's native domain
2. **DAG support**: Recursive CTEs >> $graphLookup for your use case
3. **Job queue pattern**: `FOR UPDATE SKIP LOCKED` is the industry standard
4. **ORM**: Drizzle only works with PostgreSQL
5. **Ecosystem**: Every comparable open-source project uses PostgreSQL

---

## 7. Recommendation

**Use PostgreSQL. It is not close.**

The evidence is overwhelming:

- 7 out of 7 comparable task/project management tools use PostgreSQL (or Redis for pure queuing)
- Your data model is inherently relational (8 tables with foreign keys)
- DAG operations are a first-class feature in PostgreSQL, a bolted-on afterthought in MongoDB
- `FOR UPDATE SKIP LOCKED` is the proven pattern for exactly your job queue requirement
- Drizzle ORM (your planned ORM) does not support MongoDB
- Multiple projects have migrated FROM MongoDB TO PostgreSQL for these exact reasons
- Zero projects have migrated from PostgreSQL to MongoDB for task management

The only scenario where MongoDB would be preferable is if your data were truly document-shaped (unstructured, deeply nested, schema-less). Your 8-table relational schema with DAG dependencies is the opposite of that.

### Recommended Stack

```
PostgreSQL (database)
  + Drizzle ORM (type-safe schema + queries)
  + FOR UPDATE SKIP LOCKED (job queue)
  + Recursive CTEs (DAG traversal)
  + CHECK constraints (status state machines)
  + Triggers (audit trail)
```

---

## Sources

- [Hatchet HN Discussion](https://news.ycombinator.com/item?id=43572733)
- [Hatchet GitHub](https://github.com/hatchet-dev/hatchet-v1)
- [Nango: Migrating from Temporal to Postgres](https://nango.dev/blog/migrating-from-temporal-to-a-postgres-based-task-orchestrator)
- [Graphile Worker](https://worker.graphile.org/docs)
- [BullMQ Architecture](https://docs.bullmq.io/guide/architecture)
- [Plane.so Self-Hosting](https://developers.plane.so/self-hosting/methods/docker-compose)
- [Linear Tech Stack](https://himalayas.app/companies/linear/tech-stack)
- [Trigger.dev GitHub](https://github.com/triggerdotdev/trigger.dev)
- [PostgreSQL SKIP LOCKED](https://www.dbpro.app/blog/postgresql-skip-locked)
- [MongoDB $graphLookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/)
- [Fusionbox: Recursive CTEs + Topological Sort](https://www.fusionbox.com/blog/detail/graph-algorithms-in-a-database-recursive-ctes-and-topological-sort-with-postgres/620/)
- [Infisical: MongoDB to PostgreSQL Migration](https://infisical.com/blog/postgresql-migration-technical)
- [Tyk: MongoDB to PostgreSQL Migration](https://tyk.io/blog/migrating-to-postgres-from-mongodb-tyks-migration-tool-makes-it-easy/)
- [Drizzle ORM MongoDB Issue](https://github.com/drizzle-team/drizzle-orm/issues/2377)
- [Prisma MongoDB Connector](https://www.prisma.io/docs/orm/overview/databases/mongodb)
- [MongoDB findAndModify](https://www.mongodb.com/docs/manual/reference/command/findandmodify/)
- [Bytebase: Postgres vs MongoDB 2025](https://www.bytebase.com/blog/postgres-vs-mongodb/)
- [MongoDB Job Queue Crisis](https://medium.com/@khaledosama52/mongodb-job-queue-crisis-8280b563c8f3)
