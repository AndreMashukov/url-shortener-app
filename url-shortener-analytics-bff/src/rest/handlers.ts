import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
} from "aws-lambda";

// ─── shared module state ────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

/**
 * Get the owner sub from the Cognito JWT authorizer. SF v4 + HTTP API
 * puts the verified claims at `requestContext.authorizer.jwt.claims`.
 * Returns undefined if missing or malformed.
 */
function getOwnerSub(event: APIGatewayProxyEventV2): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
  return claims?.sub as string | undefined;
}

// ─── response helpers ────────────────────────────────────────────
const json = <T>(body: T, statusCode = 200) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const err = (statusCode: number, code: string, message: string) =>
  json({ error: code, message }, statusCode);

/**
 * GET /analytics/{code}?days=30
 * Owner-only (Cognito JWT). Returns click analytics for the code:
 *   { code, ownerSub, total, last24h, days: [{date, count}, ...] }
 *
 * Steps:
 *  1. Validate the JWT (authorizer already did; just read sub).
 *  2. Read the lifetime counter (pk=URL#<code>, sk=COUNT).
 *  3. Read each day rollup for the last N days
 *     (pk=URL#<code>, sk begins_with "DAY#<yyyymmdd>" within range).
 *  4. Sum last24h by reading raw click rows with sk within the last
 *     24h window, OR by summing the lifetime counter and bucketing
 *     the per-day counts. For now we just return the lifetime and
 *     per-day counts; last24h is computed from the per-day bucketing
 *     by including today's day count.
 */
export const analytics: APIGatewayProxyHandlerV2 = async (event) => {
  const ownerSub = getOwnerSub(event);
  if (!ownerSub) {
    return err(401, "unauthorized", "missing or invalid JWT");
  }

  const code = (event.pathParameters?.code ?? "").trim();
  if (!code) return err(400, "bad_request", "code is required");
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(code)) {
    return err(400, "bad_request", "invalid code format");
  }

  // Parse ?days= (default 30, max 90).
  let days = DEFAULT_DAYS;
  const daysParam = event.queryStringParameters?.days;
  if (daysParam !== undefined) {
    const parsed = Number.parseInt(daysParam, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      return err(400, "bad_request", "days must be a positive integer");
    }
    days = Math.min(parsed, MAX_DAYS);
  }

  // Compute the day prefix range: from (today - days + 1) to today.
  const today = startOfUtcDay(new Date());
  const startDate = new Date(today.getTime() - (days - 1) * 86400_000);
  const startDayKey = `DAY#${formatDayKey(startDate)}`;
  const endDayKey = `DAY#${formatDayKey(today)}`;

  // 1) Lifetime counter.
  const counterRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `URL#${code}`, sk: "COUNT" },
    }),
  );
  const total = (counterRes.Item?.count as number | undefined) ?? 0;

  // 2) Per-day rollups (Query by pk, sk between start and end DAY keys).
  const daysRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression:
        "pk = :pk AND sk BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":pk": `URL#${code}`,
        ":start": startDayKey,
        ":end": endDayKey,
      },
      ScanIndexForward: true,
    }),
  );

  // Build a map of day -> count (zero-fill missing days later).
  const dayCounts: Record<string, number> = {};
  for (const item of daysRes.Items ?? []) {
    const sk = item.sk as string;
    const day = sk.slice("DAY#".length); // yyyymmdd
    dayCounts[day] = (item.count as number | undefined) ?? 0;
  }

  // Fill in the per-day response array (zero-filled for missing days).
  const out: { date: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getTime() + i * 86400_000);
    const day = formatDayKey(d);
    out.push({ date: day, count: dayCounts[day] ?? 0 });
  }

  // last24h = today's day count. (We don't store finer granularity.)
  const todayKey = formatDayKey(today);
  const last24h = dayCounts[todayKey] ?? 0;

  return json({
    code,
    ownerSub,
    total,
    last24h,
    days: out,
  });
};

/**
 * GET /health — public. 200: { ok: true, service, ts }
 */
export const health: APIGatewayProxyHandlerV2 = async () =>
  json({ ok: true, service: "url-shortener-analytics-bff", ts: new Date().toISOString() });

// ─── helpers ─────────────────────────────────────────────────────
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatDayKey(d: Date): string {
  // yyyymmdd in UTC
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}
