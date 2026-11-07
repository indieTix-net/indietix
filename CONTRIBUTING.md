# Contributing to IndieTix

Ideas, bug reports, plugins and pull requests are welcome.

## Before your first pull request

Everyone contributing code or docs signs the [Contributor License Agreement](./CLA.md) once. You keep the copyright in your work; the agreement lets IndieTix stay open source and also fund itself through hosted plans. A bot asks you to agree on your first pull request.

## How the repo works

Every folder is one piece of the platform, with its own README and tests. Start with [`infrastructure/README.md`](./infrastructure/README.md) for the big picture and local setup.

- **Run the tests** for any folder you change: `cd <folder> && npm install && npm test`. You need Docker running and Node 22.
- **CI** runs the suites your change affects on every pull request, including everything downstream of shared code (`sms-utils`, `ticket-pdf-lib`, `test-db-harness`, and the schema in `clientSetup-Teardown`).
- **Keep pull requests small and focused.** Change existing code in place rather than restructuring it, and put a new feature in its own clearly commented block.
- **Schema changes must be safe to re-run.** Update `createDatabaseObjects` for new venues and `migrations.sql` for existing ones, together.
- **Never commit secrets.** Credentials belong in AWS Secrets Manager or a venue's Client Settings, never in code, docs or examples.

The full guide is in `infrastructure/README.md`, under "Tests, CI, and contributing".

## Security issues

Please don't open a public issue for a security problem. Email indietix@indietix.net instead.
