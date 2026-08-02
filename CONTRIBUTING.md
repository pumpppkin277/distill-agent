# Contributing

Issues and pull requests are welcome. Keep adapters generic, include tests for safety boundaries, and never add real tenant data or credentials.

```bash
pnpm install
pnpm typecheck
pnpm test
```

Changes to Context behavior should cover scope isolation, lifecycle state, expiration, and the rule that retrieved Context cannot bypass approval.
