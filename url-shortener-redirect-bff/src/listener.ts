import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

// One DocumentClient per warm Lambda container. AWS_REGION is set
// automatically by the Lambda runtime.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? "";

/**
 * Listener leg of redirect-bff — sole consumer of MappingCreated.
 *
 * Wired to an SQS queue fed by an EventBridge rule on the bus.
 * For each MappingCreated event, upserts a lean row into the local
 * RedirectsTable so the redirect handler can serve a single GetItem
 * per code (no cross-stack reads against app-bff's MappingsTable).
 *
 * Idempotency: we use PutCommand (not UpdateItem) with no condition.
 * Replaying an SQS message just rewrites the same row with the same
 * values — at-least-once delivery becomes effectively exactly-once
 * because the input is purely a function of the event content. Future
 * MaintenanceUpdate / Delete handlers can layer conditions on top
 * (e.g. require version > current.version).
 *
 * Batch failure reporting (functionResponseType: ReportBatchItemFailures)
 * means a single bad record does not poison the whole batch.
 */
export const handle = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  log("info", "listener invoked", {
    table: TABLE_NAME,
    recordCount: event.Records.length,
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      log("error", "listener record failed", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  log("info", "listener done", {
    succeeded: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  // EventBridge -> SQS delivers a body that looks like:
  //   { "version": "0", "id": "...", "detail-type": "...",
  //     "source": "...", "account": "...", "time": "...",
  //     "region": "...", "resources": [...], "detail": { ... } }
  const body = JSON.parse(record.body) as Record<string, unknown>;

  const detail = (body.detail as Record<string, unknown>) ?? body;
  const code = detail.code as string | undefined;
  const longUrl = detail.longUrl as string | undefined;

  if (!code || !longUrl) {
    // Malformed event — log and ack to drop it. Better than
    // infinite retries on a poison pill.
    log("error", "listener: missing code or longUrl in detail", {
      messageId: record.messageId,
      detailKeys: Object.keys(detail),
    });
    return;
  }

  const time = (body.time as string) ?? new Date().toISOString();
  const ownerSub = (detail.ownerSub as string | undefined) ?? null;
  const alias = (detail.alias as string | null | undefined) ?? null;
  const version = (detail.version as number | undefined) ?? 1;
  const createdAt = (detail.createdAt as string | undefined) ?? time;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: code,
        longUrl,
        ownerSub,
        alias,
        version,
        createdAt,
        materializedAt: new Date().toISOString(),
        sourceEventId: (body.id as string | undefined) ?? record.messageId,
      },
    }),
  );

  log("info", "lean row upserted", {
    messageId: record.messageId,
    code,
    longUrl,
    version,
  });
}

function log(
  level: "info" | "error",
  message: string,
  extra: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    service: "url-shortener-redirect-bff",
    fn: "listener",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}