# AGENTS.md — URL Shortener App

Instructions for AI agents working in this repository.

## Project overview

AWS serverless URL shortener built with **Serverless Framework v4** and **Nx**. Event-sourced / CQRS architecture: four CloudFormation stacks share one EventBridge bus in **`ap-southeast-1`**.

| Stack | Directory | MCP service name (dev) |
|-------|-----------|-------------------------|
| Event hub | `url-shortener-event-hub/` | `url-shortener-event-hub-dev` |
| App BFF | `url-shortener-app-bff/` | `url-shortener-app-bff-dev` |
| Redirect BFF | `url-shortener-redirect-bff/` | `url-shortener-redirect-bff-dev` |
| Analytics BFF | `url-shortener-analytics-bff/` | `url-shortener-analytics-bff-dev` |

**Deploy order:** event-hub → app-bff → redirect-bff / analytics-bff  
**Default stage:** `dev` · **Region:** `ap-southeast-1`

## Commands

```bash
yarn install
yarn test
yarn typecheck
yarn package:event-hub && yarn deploy:event-hub   # bus first
yarn deploy:app-bff
yarn deploy:redirect-bff
yarn deploy:analytics-bff
yarn show:projects
```

Prefer Nx/yarn scripts over invoking `serverless` directly when a target exists.

## Debugging live AWS resources

When the task involves **actual deployed state** (Lambda errors, logs, API Gateway, DynamoDB, SQS, IAM, deploy history, “is it live?”), use **Serverless MCP** — do not infer behavior from `serverless.yml` alone.

1. Read `.cursor/skills/serverless-aws-debug/SKILL.md` and follow its workflow.
2. Stack names and examples: `.cursor/skills/serverless-aws-debug/stacks.md`.
3. Call MCP tools with `region: ap-southeast-1` and the correct `serviceName` (e.g. `url-shortener-app-bff-dev`).

| Live AWS question | Use MCP |
|-------------------|---------|
| Errors, timeouts, metrics, logs | `aws-lambda-info`, `aws-errors-info`, `aws-logs-search` |
| Full stack health | `service-summary` (`serviceWideAnalysis: true`) |
| Resource inventory | `list-resources` |
| Recent infra changes | `deployment-history` |
| API / DDB / SQS / IAM details | `aws-http-api-gateway-info`, `aws-dynamodb-info`, etc. |

| Code / config question | Use repo |
|------------------------|----------|
| Handler logic, types, tests | `src/` in each BFF |
| IaC structure | `serverless.yml`, `serverless/*.yml` |
| Architecture rationale | `design-research.md` |
| Known EventBridge issues | `docs/eventbridge-sqs-delivery-issue.md` |

**Cursor MCP setup:** `serverless` server via `npx serverless mcp`, credentials from project `.env` (see `CLAUDE.md`).

## Code conventions

- **Node 20+**, TypeScript, yarn workspaces.
- Match existing patterns in each BFF; reuse libs under `libs/` when present.
- Minimal diffs — only change what the task requires.
- Never commit `.env` or secrets.
- Only create git commits when the user explicitly asks.

## Key architecture notes

- **app-bff** writes mappings to DynamoDB; a **DDB stream trigger** emits `MappingCreated` (sole producer — no direct PutEvents from the handler).
- **redirect-bff** listens for `MappingCreated` and materializes a lean redirect view.
- **analytics-bff** consumes analytics-related events.
- Cognito JWT authorizer on HTTP APIs where configured.

## Related docs

- `CLAUDE.md` — Claude/Cursor-specific MCP setup and stack summary
- `.cursor/skills/serverless-aws-debug/SKILL.md` — AWS investigation workflow
- `design-research.md` — architecture deep dive
