# Contributing

Thanks for helping improve the print service. Start with the [architecture](docs/ARCHITECTURE.md), [deployment](docs/DEPLOYMENT.md) and [security](docs/SECURITY.md) guides. Open an issue for behavior changes that affect payment, customer data or the physical printer before building a large patch.

Use Node 22+, run `npm ci`, `npm run typecheck`, `npm test` (requires a PostgreSQL test database; see `.github/workflows/ci.yml`), and `npm run build`. In a pull request, explain the failure mode, migration and rollback steps where relevant, and how you tested payments and printer recovery. Automated tests mock external services; real chain and printer behavior require a supervised preprod check.

Never include actual `.env` files, access keys, database dumps, signed payments, customer addresses or production G-code in commits, issues or logs. Keep example values unmistakably fake. Report security problems privately using [the security policy](SECURITY.md) instead of filing a public exploit report. Contributions are submitted under the repository's license; do not copy third-party code or assets without a compatible license or written permission. The [open-source checklist](docs/OPEN_SOURCE_CHECKLIST.md) records a licensing issue that must be resolved before publication.
