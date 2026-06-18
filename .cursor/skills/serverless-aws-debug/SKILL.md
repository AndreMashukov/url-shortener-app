---
name: serverless-aws-debug
description: >-
  Debug and inspect live AWS resources for this Serverless Framework monorepo
  using the Serverless MCP. Use when investigating Lambda failures, CloudWatch
  logs, API Gateway, DynamoDB, SQS, IAM, deployment history, or verifying
  deployed state differs from serverless.yml — or when the user asks to check
  actual AWS resources, production/dev behavior, or stack health.
---

# Serverless AWS Debug (MCP)

Use **Serverless MCP tools** (server name: `serverless`) as the primary way to inspect live AWS resources in this repo. Local `serverless.yml` shows intent; MCP shows reality.

## Prerequisites

- Serverless MCP enabled in Cursor (`npx serverless mcp`, env from project `.env`)
- Default **region:** `ap-southeast-1`
- Default **stage:** `dev`
- Service name format: `{service-from-yml}-{stage}` (e.g. `url-shortener-app-bff-dev`)

See [stacks.md](stacks.md) for this repo's stack names and deploy order.

## Decision: MCP vs other tools

```
Need live AWS data? ──yes──► Serverless MCP
        │
        no
        ▼
Code/config question only? ──► Read repo files
Deploy/package locally?     ──► nx / serverless CLI (not MCP)
```

Do **not** fall back to raw `aws` CLI when MCP credentials fail — explain the error, report region/profile used, and ask the user to fix `.env` or specify profile.

## Standard workflow

1. **Identify stack** — map the user's question to one of the four stacks (see stacks.md). If unclear, ask which BFF or event-hub.
2. **Read local config** — skim `serverless.yml` for `provider.region`, `provider.stage`, resource names.
3. **Discover resources** — `list-resources` with `serviceName`, `serviceType: serverless-framework`, `region: ap-southeast-1`.
4. **Broad overview** — `service-summary` with `serviceWideAnalysis: true`, `serviceName`, `cloudProvider: aws`, `serviceType: aws`.
5. **Drill down** — resource-specific tools (see below).
6. **Correlate** — tie MCP findings back to handler code and IaC in the repo.

Skip `list-projects` when working in this repo — stack names are known (stacks.md). Use `list-projects` only for unfamiliar workspace roots.

## Tool selection

| Goal | Tool | Notes |
|------|------|-------|
| Full stack snapshot | `service-summary` | `serviceWideAnalysis: true` — start here for incidents |
| Inventory Lambdas, APIs, tables | `list-resources` | Before targeting specific IDs |
| Lambda failures / metrics | `aws-lambda-info` | Pass function names from list-resources |
| Error patterns (grouped) | `aws-errors-info` | Default 3h window; ask user before longer ranges (cost) |
| Raw log lines | `aws-logs-search` | After errors-info; pass log group IDs |
| Tail recent logs | `aws-logs-tail` | Quick recent activity |
| HTTP API (v2) | `aws-http-api-gateway-info` | app-bff, redirect-bff, analytics-bff |
| REST API (v1) | `aws-rest-api-gateway-info` | If stack uses REST API |
| DynamoDB | `aws-dynamodb-info` | Tables, streams, metrics |
| SQS | `aws-sqs-info` | Queue depth, DLQ |
| S3 | `aws-s3-info` | Buckets tied to stack |
| IAM roles | `aws-iam-info` | Permission / trust issues |
| Alarms | `aws-cloudwatch-alarms` | Firing / history |
| Recent deploys | `deployment-history` | Last 7 days of stack events |
| Framework docs | `docs` | Serverless v4 syntax — not live AWS |

Always pass `region: ap-southeast-1` unless the user specifies another region.

## Common investigation paths

### Lambda / 5xx / timeouts

1. `service-summary` (wide) or `aws-lambda-info` on suspect functions
2. `aws-errors-info` with `serviceWideAnalysis: true` for the stack
3. `aws-logs-search` with log groups + request ID or error string

### API / auth / CORS

1. `list-resources` → API IDs
2. `aws-http-api-gateway-info` with those IDs
3. Compare authorizer / routes with `serverless.yml` and handler code

### EventBridge / missing events

1. Check app-bff trigger Lambda (`aws-lambda-info`)
2. Check redirect-bff / analytics-bff listener Lambdas
3. `aws-errors-info` on listener log groups
4. See `docs/eventbridge-sqs-delivery-issue.md` for known patterns

### Post-deploy regression

1. `deployment-history` for the affected stack
2. `service-summary` to compare resource health after deploy time

## Cost and safety

- Log tools default to **3 hours** — do not extend without explicit user approval (`confirmationToken` flow).
- Never print secrets from MCP responses (env vars, tokens).
- Report which stack, region, and time window were queried in summaries.

## Output format

Structure findings for the user:

```markdown
## AWS investigation: [short title]

**Stack:** url-shortener-app-bff-dev | **Region:** ap-southeast-1 | **Window:** [time range]

### Findings
- [Concrete observation from MCP]

### Likely cause
- [Inference tied to evidence]

### Repo follow-up
- [File/handler to inspect or change]
```

## Additional resources

- Stack names and architecture: [stacks.md](stacks.md)
- Project conventions: [CLAUDE.md](../../../CLAUDE.md)
