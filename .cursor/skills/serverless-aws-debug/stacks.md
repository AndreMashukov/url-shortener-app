# Stack reference (url-shortener-app)

All stacks use `custom.subsys: url-shortener`, default stage `dev`, region `ap-southeast-1`.

## CloudFormation / MCP service names

| Directory | `serviceName` for MCP | Deploy order |
|-----------|----------------------|--------------|
| `url-shortener-event-hub/` | `url-shortener-event-hub-dev` | 1 — bus must exist first |
| `url-shortener-app-bff/` | `url-shortener-app-bff-dev` | 2 |
| `url-shortener-redirect-bff/` | `url-shortener-redirect-bff-dev` | 3 |
| `url-shortener-analytics-bff/` | `url-shortener-analytics-bff-dev` | 3 |

Replace `dev` with the target stage when investigating non-dev environments.

## Typical resources per stack

### url-shortener-event-hub-dev

- EventBridge custom bus
- Archive / supporting resources (see `serverless/bus.yml`, `serverless/archive.yml`)

### url-shortener-app-bff-dev

- HTTP API + Cognito JWT authorizer
- Lambdas: rest handlers (shorten, me/urls, health), DDB stream **trigger**
- DynamoDB Mappings table + stream
- Emits `MappingCreated` via trigger only (not direct PutEvents)

### url-shortener-redirect-bff-dev

- HTTP API (redirect routes)
- Listener Lambda(s) for `MappingCreated` → lean materialized view
- DynamoDB redirect view table

### url-shortener-analytics-bff-dev

- HTTP API (analytics routes)
- Listener Lambdas for analytics events
- DynamoDB analytics tables

## MCP call examples

```json
{
  "serviceName": "url-shortener-app-bff-dev",
  "serviceType": "serverless-framework",
  "region": "ap-southeast-1"
}
```

```json
{
  "serviceType": "aws",
  "serviceWideAnalysis": true,
  "serviceName": "url-shortener-redirect-bff-dev",
  "cloudProvider": "aws",
  "region": "ap-southeast-1"
}
```
