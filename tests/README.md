# Tests

- `node tests/unit.test.mjs`: streak rules (including schedule history) and course validation.
- `node tests/api.test.mjs http://127.0.0.1:8799`: 69 API checks (groups, auth, isolation, sync, courses, reports, size limits). Run against a LOCAL server only, never production, because it creates groups and courses:

```
wrangler d1 execute hill-speak --local --file schema.sql
wrangler dev --local --port 8799 --ip 127.0.0.1 --compatibility-date 2026-04-17
```

(The pinned wrangler's local runtime only supports compatibility dates up to 2026-04-17; the override is local-only.)
