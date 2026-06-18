import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
} from "aws-lambda";

// ─── shared module state ─────────────────────...
// ─── shared module state ────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const BUS_NAME = process.env.BUS_NAME ?? "";
const EVENT_SOURCE = process.env.EVENT_SOURCE ?? "url-shortener.redirect";

// ─── response helpers ────────────────────────────────────────────
const json = <T>(body: T, statusCode = 200) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const err = (statusCode: number, code: string, message: string) =>
  json({ error: code, message }, statusCode);

/**
 * GET /{code}
 * Public (no authorizer). Resolves a short code to its long URL
 * via the lean RedirectsTable (materialized by the listener).
 *
 * 302: Location header set to the long URL.
 * 404: code not found in the lean view (not yet materialized, or
 *      never existed).
 * 410: code is in the lean view but marked deleted (future).
 *
 * Caching: we return Cache-Control: public, max-age=60 to let CDNs
 * absorb the bulk of redirect traffic. Short URL -> long URL mappings
 * are stable for the lifetime of the mapping; the 60s TTL is a safety
 * floor for any future "tombstone" deletion flow.
 */
export const redirect: APIGatewayProxyHandlerV2 = async (event, context) => {
  // Allow the 302 to return immediately without waiting for the
  // fire-and-forget PutEvents to drain. The SDK PutEvents request
  // will continue in the background; in practice Lambda keeps the
  // runtime alive long enough to complete it because the event loop
  // has no other work pending.
  context.callbackWaitsForEmptyEventLoop = false;

  const code = (event.pathParameters?.code ?? "").trim();
  if (!code) return err(400, "bad_request", "code is required");
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(code)) {
    return err(400, "bad_request", "invalid code format");
  }

  let res;
  try {
    res = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: code },
      }),
    );
  } catch (e) {
    console.error("redirect: getItem failed", { code, error: String(e) });
    return err(500, "internal_error", "lookup failed");
  }

  const item = res.Item;
  if (!item) {
    return err(404, "not_found", `no mapping for code '${code}'`);
  }

  const longUrl = item.longUrl as string | undefined;
  if (!longUrl) {
    return err(500, "internal_error", "row missing longUrl");
  }

  // Publish click analytics without blocking the redirect response.
  void emitClickRecorded({
    code,
    longUrl,
    ownerSub: item.ownerSub as string | undefined,
    sourceEventId: item.sourceEventId as string | undefined,
    userAgent: event.requestContext.http?.userAgent,
    ip: event.requestContext.http?.sourceIp,
  }).catch((e) => {
    console.error("redirect: click event publish failed", {
      code,
      error: String(e),
    });
  });

  return {
    statusCode: 302,
    headers: {
      Location: longUrl,
      "Cache-Control": "public, max-age=60",
    },
    body: "",
  };
};

type ClickDetail = {
  code: string;
  longUrl: string;
  ownerSub?: string;
  sourceEventId?: string;
  userAgent?: string;
  ip?: string;
};

/**
 * Emit a `ClickRecorded` event to the bus. Never throws — failures are
 * logged and swallowed. We send a single record (chunked only if needed
 * in the future). Detail is a small flat object so downstream consumers
 * (analytics-bff) don't have to chase references.
 */
async function emitClickRecorded(detail: ClickDetail): Promise<void> {
  if (!BUS_NAME) {
    console.warn("emitClickRecorded: BUS_NAME not set, skipping");
    return;
  }
  const occurredAt = new Date().toISOString();
  try {
    const res = await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS_NAME,
            Source: EVENT_SOURCE,
            DetailType: "ClickRecorded",
            Time: new Date(occurredAt),
            Detail: JSON.stringify({
              code: detail.code,
              longUrl: detail.longUrl,
              ownerSub: detail.ownerSub,
              sourceEventId: detail.sourceEventId,
              userAgent: detail.userAgent,
              ip: detail.ip,
              occurredAt,
            }),
          },
        ],
      }),
    );
    if (res.FailedEntryCount && res.FailedEntryCount > 0) {
      console.warn("emitClickRecorded: PutEvents partial failure", {
        code: detail.code,
        failures: res.Entries?.filter((e) => e.ErrorCode),
      });
    }
  } catch (e) {
    console.error("emitClickRecorded: PutEvents threw", {
      code: detail.code,
      error: String(e),
      busName: BUS_NAME,
      source: EVENT_SOURCE,
    });
  }
}

/**
 * GET /health
 * Public. 200: { ok: true, service, ts }
 */
export const health: APIGatewayProxyHandlerV2 = async () =>
  json({ ok: true, service: "url-shortener-redirect-bff", ts: new Date().toISOString() });