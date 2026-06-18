import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

// ─── shared module state ────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
  throw new Error("TABLE_NAME environment variable is required");
}

/**
 * SQS event handler — consumes `ClickRecorded` events from the bus
 * (via the analytics listener queue) and materializes:
 *   1. A raw click row:    pk="URL#<code>", sk="<ts>#<eventId>"
 *   2. A day rollup:       pk="URL#<code>", sk="DAY#<yyyymmdd>"   (ADD count :1)
 *   3. A lifetime counter: pk="URL#<code>", sk="COUNT"            (ADD count :1)
 *
 * Idempotency: the raw click row is written with attribute_not_exists
 * on pk+sk. Duplicate SQS deliveries skip counter updates, so retries
 * after partial success cannot double-count.
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

  const occurredAt = resolveOccurredAt(detail.occurredAt);
  const dayKey = formatDayKey(occurredAt);
  // Use the SQS messageId as the event id; it's globally unique and
  // ensures the raw click row's sk is unique even on retries.
  const eventId = record.messageId;

  const pk = `URL#${code}`;
  const sk = `${occurredAt}#${eventId}`;

  const inserted = await insertRawClickRow({
    pk,
    sk,
    code,
    occurredAt,
    detail,
  });
  if (!inserted) {
    return;
  }

  // 2) Day rollup: ADD count :1.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk: `DAY#${dayKey}` },
      UpdateExpression: "ADD #c :one SET #day = :day, #code = :code, #ownerSub = :ownerSub",
      ExpressionAttributeNames: {
        "#c": "count",
        "#day": "day",
        "#code": "code",
        "#ownerSub": "ownerSub",
      },
      ExpressionAttributeValues: {
        ":one": 1,
        ":day": dayKey,
        ":code": code,
        ":ownerSub": detail.ownerSub ?? null,
      },
    }),
  );

  // 3) Lifetime counter: ADD count :1.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk: "COUNT" },
      UpdateExpression: "ADD #c :one SET #code = :code, #ownerSub = :ownerSub",
      ExpressionAttributeNames: {
        "#c": "count",
        "#code": "code",
        "#ownerSub": "ownerSub",
      },
      ExpressionAttributeValues: {
        ":one": 1,
        ":code": code,
        ":ownerSub": detail.ownerSub ?? null,
      },
    }),
  );
}

async function insertRawClickRow(input: {
  pk: string;
  sk: string;
  code: string;
  occurredAt: string;
  detail: ClickDetail;
}): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: input.pk,
          sk: input.sk,
          code: input.code,
          longUrl: input.detail.longUrl,
          ownerSub: input.detail.ownerSub,
          sourceEventId: input.detail.sourceEventId,
          userAgent: input.detail.userAgent,
          ip: input.detail.ip,
          occurredAt: input.occurredAt,
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw e;
  }
}

function resolveOccurredAt(value: string | undefined): string {
  if (value === undefined || value === "") {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`listener: invalid occurredAt '${value}'`);
  }

  return parsed.toISOString();
}

function formatDayKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`listener: cannot derive day key from '${isoTimestamp}'`);
  }

  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}
