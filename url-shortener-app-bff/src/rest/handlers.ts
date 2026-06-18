import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";

import { generateCode, isValidChecksum } from "../lib/code";
import type { UrlMappingRow } from "../models/mapping";

// ─── shared module state ────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const DOMAIN = process.env.DOMAIN ?? "url-shortener.app";
const SUBSYS = "url-shortener";

// ─── types ───────────────────────────────────────────────────────
type CognitoClaims = Record<string, string | undefined>;
type JwtAuthorizer = { jwt: { claims: CognitoClaims } };
type AuthorizedRequest = APIGatewayProxyEventV2WithRequestContext<
  APIGatewayProxyEventV2["requestContext"] & { authorizer?: JwtAuthorizer }
>;

// ─── response helpers ────────────────────────────────────────────
const ok = <T>(body: T, statusCode = 200) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const err = (statusCode: number, code: string, message: string) =>
  ok({ error: code, message }, statusCode);

/**
 * PUT /shorten
 * Cognito JWT required (attached at the route).
 * Body: { longUrl: string; alias?: string }
 * 201: { code, shortUrl, longUrl, alias, createdAt }
 */
export const createMapping: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) return err(401, "unauthorized", "missing or invalid JWT");

  let body: { longUrl?: unknown; alias?: unknown };
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body ?? {});
  } catch {
    return err(400, "bad_request", "request body must be valid JSON");
  }
  const longUrl = typeof body.longUrl === "string" ? body.longUrl.trim() : "";
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";

  if (!longUrl || !/^https?:\/\//.test(longUrl)) {
    return err(400, "bad_request", "longUrl must be a valid http(s) URL");
  }
  if (alias && !/^[a-zA-Z0-9_-]{1,32}$/.test(alias)) {
    return err(400, "bad_request", "alias must match [a-zA-Z0-9_-]{1,32}");
  }
  if (alias && !isValidChecksum(alias)) {
    return err(400, "bad_request", "alias checksum mismatch");
  }

  // ULID-based code with up to 5 retries on collision (anti-clash).
  let code = "";
  let createdAt = "";
  for (let i = 0; i < 5; i++) {
    const candidate = alias || generateCode();
    try {
      createdAt = new Date().toISOString();
      const row: UrlMappingRow = {
        pk: `${SUBSYS}#MAPPING`,
        sk: candidate,
        discriminator: "MAPPING",
        version: 1,
        code: candidate,
        longUrl,
        ownerSub: sub,
        createdAt,
        ...(alias ? { alias } : {}),
        gsisk: candidate,
      };
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: row as unknown as Record<string, unknown>,
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }));
      code = candidate;
      break;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        if (alias) return err(409, "conflict", "alias already in use");
        continue;
      }
      throw e;
    }
  }
  if (!code) return err(503, "unavailable", "could not allocate a unique code; please retry");

  // MappingCreated is emitted by the trigger lambda via the DDB stream
  // (src/trigger.ts). The handler does NOT call PutEvents directly —
  // see serverless.yml header comment and design-research.md §13.
  return ok({ code, shortUrl: `https://${DOMAIN}/${code}`, longUrl, alias: alias || null, createdAt }, 201);
};

/**
 * GET /me/urls
 * Cognito JWT required.
 * 200: { count: number, items: UrlMappingRow[] }
 */
export const listMyUrls: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) return err(401, "unauthorized", "missing or invalid JWT");

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "gsi1",
    KeyConditionExpression: "ownerSub = :s",
    ExpressionAttributeValues: { ":s": sub },
    Limit: 100,
  }));
  const items = (res.Items ?? []).map((item) => ({
    code: item.code,
    shortUrl: `https://${DOMAIN}/${item.code}`,
    longUrl: item.longUrl,
    alias: item.alias ?? null,
    createdAt: item.createdAt,
  }));
  return ok({ count: items.length, items });
};

/**
 * GET /health
 * Public. No JWT required (route has no authorizer).
 * 200: { ok: true, service, ts }
 */
export const health: APIGatewayProxyHandlerV2 = async () =>
  ok({ ok: true, service: "url-shortener-app-bff", ts: new Date().toISOString() });
