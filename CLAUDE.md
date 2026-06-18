# URL Shortener App — Agent Guide

AWS serverless monorepo (Serverless Framework v4, Nx). Four CloudFormation stacks on one EventBridge bus in `ap-southeast-1`.

## When to use Serverless MCP

Use the **Serverless MCP** (`serverless` server in Cursor) whenever the task requires **live AWS state** — not just reading `serverless.yml` or local code.

| Use MCP | Use local code / CLI instead |
|---------|------------------------------|
| Lambda errors, timeouts, cold starts | Handler logic, types, unit tests |
| CloudWatch logs and error patterns | Log format in source code |
| API Gateway / DynamoDB / SQS / IAM as deployed | IaC templates and design docs |
| Deployment history and stack events | `serverless package` locally |
| “Is this resource actually deployed?” | Architecture docs |

**Do not guess** from templates alone when the question is about production/dev behavior. Call MCP tools first, then correlate with repo code.

Read and follow `.cursor/skills/serverless-aws-debug/SKILL.md` for the full workflow, tool selection, and project-specific stack names.

## Stacks (default stage: `dev`)

| Stack directory | CloudFormation name (`service-stage`) | Role |
|-----------------|----------------------------------------|------|
| `url-shortener-event-hub/` | `url-shortener-event-hub-dev` | EventBridge bus (deploy first) |
| `url-shortener-app-bff/` | `url-shortener-app-bff-dev` | Authoring API + Cognito + DDB stream trigger |
| `url-shortener-redirect-bff/` | `url-shortener-redirect-bff-dev` | Redirect + MappingCreated listener |
| `url-shortener-analytics-bff/` | `url-shortener-analytics-bff-dev` | Analytics API + listeners |

- **Region:** `ap-southeast-1` (all stacks)
- **Deploy order:** event-hub → app-bff → redirect-bff / analytics-bff
- **Credentials:** project `.env` (loaded by Serverless MCP via `~/.cursor/mcp.json`)

## MCP setup (Cursor)

Configured globally in `~/.cursor/mcp.json`:

```json
"serverless": {
  "command": "npx",
  "args": ["serverless", "mcp"],
  "envFile": "/Users/andrey-mac/projects/url-shortener-app/.env"
}
```

If MCP fails: restart the server in **Settings → MCP**, check **Output → MCP Logs**, confirm `.env` has `SERVERLESS_*` and AWS keys.

## Conventions

- Prefer Nx targets (`nx deploy url-shortener-app-bff`) over raw `serverless` where defined.
- Event-sourced / CQRS patterns — see `design-research.md`.
- Never commit secrets; `.env` is gitignored.
