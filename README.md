# url-shortener-app

AWS serverless URL shortener built with **Serverless Framework v4** and **Nx**. Four CloudFormation stacks share one EventBridge bus in **`ap-southeast-1`**, using event-sourced / CQRS patterns ([design-research.md](./design-research.md)).

## Architecture

| Stack | Role | Key APIs |
|-------|------|----------|
| `url-shortener-event-hub` | Shared EventBridge bus + archive | — (deploy first) |
| `url-shortener-app-bff` | Authoring | `PUT /shorten`, `GET /me/urls` (Cognito JWT) |
| `url-shortener-redirect-bff` | Redirect + click emit | `GET /{code}` → 302 (public) |
| `url-shortener-analytics-bff` | Click analytics | `GET /analytics/{code}` (Cognito JWT, owner-only) |

**Event flow**

1. `PUT /shorten` writes a mapping to DynamoDB; the **DDB stream trigger** (sole producer) emits `MappingCreated` on the bus.
2. **redirect-bff listener** materializes a lean redirect view from `MappingCreated`.
3. `GET /{code}` reads the lean view and emits `ClickRecorded` on the bus.
4. **analytics-bff listener** aggregates clicks into its own DynamoDB table.

Each BFF owns its data store (inbound bulkhead). See [design-research.md](./design-research.md) for rationale.

## Prerequisites

- **Node.js 20+**
- **Yarn**
- **AWS credentials** with permission to deploy CloudFormation, Lambda, API Gateway, DynamoDB, EventBridge, SQS, and Cognito
- **Serverless Framework v4** (via project devDependencies / `npx serverless`)

Create a `.env` file at the repo root (gitignored) with your AWS and Serverless credentials before deploy or smoke tests. See [CLAUDE.md](./CLAUDE.md) for MCP setup.

## Quick start

```bash
yarn install
yarn typecheck
yarn test
```

Deploy in dependency order (default stage `dev`, region `ap-southeast-1`):

```bash
yarn package:event-hub && yarn deploy:event-hub
yarn deploy:app-bff
yarn deploy:redirect-bff
yarn deploy:analytics-bff
```

Stack endpoints after deploy:

```bash
yarn nx run url-shortener-app-bff:info
yarn nx run url-shortener-redirect-bff:info
yarn nx run url-shortener-analytics-bff:info
```

## End-to-end smoke test

Exercises the full path over **HTTP API Gateway** with a real **Cognito JWT** (admin-created test user):

```bash
source .env && python3 scripts/e2e-smoke.py
```

Requires `boto3` (`pip install boto3`). The script creates a mapping, waits for lean-view materialization, follows a redirect (records a click), and reads analytics.

## Common commands

| Command | Description |
|---------|-------------|
| `yarn show:projects` | List Nx projects |
| `yarn typecheck` | Typecheck all stacks |
| `yarn test` | Run tests |
| `yarn deploy:<stack>` | Deploy one stack (`event-hub`, `app-bff`, `redirect-bff`, `analytics-bff`) |
| `yarn graph` | Nx dependency graph |

Prefer `yarn deploy:*` / `yarn nx run …` over invoking `serverless` directly.

## Documentation

| Doc | Contents |
|-----|----------|
| [design-research.md](./design-research.md) | Architecture decisions and build plan |
| [AGENTS.md](./AGENTS.md) | Agent / contributor conventions |
| [CLAUDE.md](./CLAUDE.md) | Cursor MCP setup for live AWS debugging |
| [docs/eventbridge-sqs-delivery-issue.md](./docs/eventbridge-sqs-delivery-issue.md) | Resolved EventBridge → SQS note (analytics queues must not use `alias/aws/sqs` KMS) |

## License

UNLICENSED — private monorepo.
