---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "src/lib/__tests__/**/*"
---

# Test-Driven Development (TDD) Rules

## Mandatory Workflow

**ALWAYS write tests BEFORE implementing features.**

1. **Red**: Write a failing test that defines expected behavior
2. **Green**: Write minimum code to make the test pass
3. **Refactor**: Improve code while keeping tests green

## Test File Conventions

- Unit tests: `src/lib/__tests__/{module}.test.ts`
- Service tests: `src/lib/__tests__/services/{service}.test.ts`
- API route tests: `src/lib/__tests__/api/{route}.test.ts`
- Integration tests: `src/lib/__tests__/integration/{feature}.test.ts`

## Coverage Requirements

- Minimum 80% overall coverage
- 100% coverage for:
  - Services (`src/lib/services/`)
  - State machines (`src/lib/state-machines.ts`)
  - Error hierarchy (`src/lib/errors.ts`)
  - Validation/safety logic (`src/lib/worker/safety.ts`)

## What to Test

- **Services**: All CRUD operations, state transitions, validation, edge cases
- **State machines**: Every valid transition, every invalid transition rejection
- **API handlers**: Response shapes, error mapping, status codes
- **Worker modules**: Job handling, zombie reconciliation, safety checks
- **DB schema**: Type inference correctness (compile-time, not runtime)

## What NOT to Test

- shadcn/ui components (tested upstream)
- Drizzle ORM internals
- Next.js routing mechanics
- Simple type re-exports

## Before Claiming "Done"

```bash
pnpm test          # All tests pass
pnpm build         # No build errors
```
