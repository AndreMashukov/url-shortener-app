import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

// ─── shared module state ────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? "";

/**
 * SQS event handler — consumes `ClickRecorded` events from the bus
 * (via the analytics listener queue) and materializes:
 *   1. A raw click row:    pk="URL#<code>", sk="<ts>#<eventId>"
 *   2. A day rollup:       pk="URL#<code>", sk="DAY#<yyyymmdd>"   (ADD count :1)
 *   3. A lifetime counter: pk="URL#<code>", sk="COUNT"            (ADD count :1)
 *
 * Idempotency: the raw click row uses the unique eventId as part of sk,
 * so duplicate deliveries are absorbed (PutItem with same pk+sk is a
 * no-op). The counters will double-count on duplicate delivery, which
 * is acceptable for analytics at our volumes.
 */
export const handle = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (e) {
      console.error("listener: processRecord failed", {
        messageId: record.messageId,
        error: String(e),
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

type ClickDetail = {
  code?: string;
  longUrl?: string;
  ownerSub?: string;
  sourceEventId?: string;
  userAgent?: string;
  ip?: string;
  occurredAt?: string;
};

async function processRecord(record: SQSRecord): Promise<void> {
  const envelope = JSON.parse(record.body) as {
    "detail-type"?: string;
    source?: string;
    detail?: string | ClickDetail;
  };

  if (envelope["detail-type"] !== "ClickRecorded") {
    console.warn("listener: ignoring non-ClickRecorded record", {
      messageId: record.messageId,
      detailType: envelope["detail-type"],
    });
    return;
  }

  // detail can be a string (wire format from EventBridge -> SQS) or
  // a pre-parsed object (depending on how the message was bridged).
  const detail: ClickDetail =
    typeof envelope.detail === "string"
      ? (JSON.parse(envelope.detail) as ClickDetail)
      : (envelope.detail ?? {});

  const code = detail.code;
  if (!code) {
    throw new Error("listener: ClickRecorded detail missing 'code' field");
  }

  const occurredAt = detail.occurredAt ?? new Date().toISOString();
  const dayKey = formatDayKey(new Date(occurredAt));
  // Use the SQS messageId as the event id; it's globally unique and
  // ensures the raw click row's sk is unique even on retries.
  const eventId = record.messageId;

  const pk = `URL#${code}`;

  // 1) Raw click row (idempotent on (pk, sk) duplicate).
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk,
        sk: `${occurredAt}#${eventId}`,
        code,
        longUrl: detail.longUrl,
        ownerSub: detail.ownerSub,
        sourceEventId: detail.sourceEventId,
        userAgent: detail.userAgent,
        ip: detail.ip,
        occurredAt,
      },
    }),
  );

  // 2) Day rollup: ADD count :1.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk: `DAY#${dayKey}` },
      UpdateExpression: "ADD #c :one SET #day = :day, #code = :code",
      ExpressionAttributeNames: {
        "#c": "count",
        "#day": "day",
        "#code": "code",
      },
      ExpressionAttributeValues: {
        ":one": 1,
        ":day": dayKey,
        ":code": code,
      },
    }),
  );

  // 3) Lifetime counter: ADD count :1.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk: "COUNT" },
      UpdateExpression: "ADD #c :one SET #code = :code",
      ExpressionAttributeNames: {
        "#c": "count",
        "#code": "code",
      },
      ExpressionAttributeValues: {
        ":one": 1,
        ":code": code,
      },
    }),
  );
}

function formatDayKey(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}
