import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  DynamoDBRecord,
  DynamoDBStreamHandler,
} from "aws-lambda";

// One EventBridge client per warm Lambda container. AWS_REGION is set
// automatically by the Lambda runtime, so we don't need to configure
// the region explicitly.
const eb = new EventBridgeClient({});

const SOURCE = "url-shortener.app";
const BUS_NAME = process.env.BUS_NAME ?? "";

/**
 * Trigger leg of the Trilateral API — sole producer of MappingCreated /
 * MappingModified / MappingDeleted events on the bus.
 *
 * Wired to a DynamoDB stream on MappingsTable (NEW_AND_OLD_IMAGES).
 * Consumes CDC records and re-publishes each row change as a domain
 * event. redirect-bff subscribes via a bus rule and materializes its
 * own lean view. See design-research.md §13.
 *
 * Why this is the sole producer (not the handler): if the handler also
 * called PutEvents on success, every write would emit twice (handler
 * success path + CDC), and the redirect-bff listener would upsert its
 * lean view twice per write. The CDC leg is the single source of truth
 * for "what events happened" — it sees every INSERT/MODIFY/REMOVE, even
 * ones written by a future backfill script or a manual data fix.
 *
 * Batch failure reporting (functionResponseType:
 * ReportBatchItemFailures) means a single failed PutEvents does not
 * poison the whole shard. PutEvents accepts up to 10 entries per call,
 * so we chunk larger stream batches.
 */
export const handle: DynamoDBStreamHandler = async (event) => {
  log("info", "trigger invoked", {
    bus: BUS_NAME,
    recordCount: event.Records.length,
  });

  // Pair each surviving record with its EventBridge entry so we keep
  // the (record, entry) correspondence when chunking. If buildEntry
  // ever returns null the pair is dropped together -- slicing
  // event.Records separately from entries would misalign the indices
  // used for batchItemFailures reporting.
  const items = event.Records.flatMap((record) => {
    const entry = buildEntry(record);
    return entry ? [{ record, entry }] : [];
  });

  if (items.length === 0) {
    log("info", "trigger done (no entries)", { succeeded: 0, failed: 0 });
    return { batchItemFailures: [] };
  }

  // PutEvents hard limit: 10 entries per call. Chunk accordingly.
  const CHUNK = 10;
  const failures: { itemIdentifier: string }[] = [];

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    try {
      const result = await eb.send(
        new PutEventsCommand({
          Entries: slice.map(({ entry }) => entry),
        }),
      );

      const failedCount = result.FailedEntryCount ?? 0;
      if (failedCount > 0) {
        // PutEvents returns per-entry ErrorCode/ErrorMessage in
        // result.Entries (same order as the request). When the SDK
        // reports only a count with no per-entry details (rare, e.g.
        // throttling), fall back to retrying the whole chunk.
        const failedIndexes = (result.Entries ?? [])
          .map((entryResult, idx) => (entryResult.ErrorCode ? idx : -1))
          .filter((idx) => idx >= 0);
        const retryIndexes =
          failedIndexes.length > 0 ? failedIndexes : slice.map((_, idx) => idx);

        for (const idx of retryIndexes) {
          // idx came from a .map or .filter over `slice` itself, so
          // it is bounded by slice.length; non-null assertion is safe
          // (and the alternative is two lookups per index for no gain).
          const item = slice[idx]!;
          failures.push({ itemIdentifier: streamItemIdentifier(item.record) });
        }
        const firstError = result.Entries?.find((e) => e.ErrorMessage);
        const firstCode = result.Entries?.find((e) => e.ErrorCode);
        log("error", "trigger PutEvents partial failure", {
          failedCount,
          chunkSize: slice.length,
          retrying: retryIndexes.length,
          firstError: firstError?.ErrorMessage,
          firstCode: firstCode?.ErrorCode,
        });
      } else {
        log("info", "trigger chunk ok", { chunkSize: slice.length });
      }
    } catch (err) {
      log("error", "trigger PutEvents threw", {
        error: err instanceof Error ? err.message : String(err),
        chunkSize: slice.length,
      });
      for (const { record } of slice) {
        failures.push({ itemIdentifier: streamItemIdentifier(record) });
      }
    }
  }

  log("info", "trigger done", {
    succeeded: event.Records.length - failures.length,
    failed: failures.length,
  });

  return { batchItemFailures: failures };
};

/**
 * Build a single EventBridge PutEvents entry from a DynamoDB stream
 * record. Returns null for events we don't care about (defensive --
 * the filterPatterns in serverless.yml already drop anything other
 * than INSERT/MODIFY/REMOVE, so this is belt-and-braces).
 */
function buildEntry(rec: DynamoDBRecord): {
  Source: string;
  DetailType: string;
  Detail: string;
  EventBusName: string;
} | null {
  const eventName = rec.eventName;
  if (!eventName) return null;

  // NEW_AND_OLD_IMAGES gives us both. For REMOVE only OldImage is set;
  // for INSERT only NewImage; for MODIFY both.
  //
  // Type seam: aws-lambda's AttributeValue (in @types/aws-lambda) and
  // @aws-sdk/util-dynamodb's AttributeValue (in @aws-sdk/client-dynamodb)
  // are structurally identical at runtime but nominally distinct in
  // the type system -- the SDK's union has a $unknown discriminator
  // that aws-lambda's doesn't. Cast through `any` at the boundary;
  // the wire format is identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newRaw = rec.dynamodb?.NewImage as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oldRaw = rec.dynamodb?.OldImage as any;
  const newImage = newRaw ? unmarshall(newRaw) : undefined;
  const oldImage = oldRaw ? unmarshall(oldRaw) : undefined;

  const detailType =
    eventName === "INSERT"
      ? "MappingCreated"
      : eventName === "MODIFY"
        ? "MappingModified"
        : eventName === "REMOVE"
          ? "MappingDeleted"
          : null;

  if (!detailType) return null;

  const detail = {
    eventName,
    code: newImage?.code ?? oldImage?.code,
    longUrl: newImage?.longUrl ?? oldImage?.longUrl,
    ownerSub: newImage?.ownerSub ?? oldImage?.ownerSub,
    alias: newImage?.alias ?? oldImage?.alias ?? null,
    version: newImage?.version ?? oldImage?.version,
    createdAt: newImage?.createdAt ?? oldImage?.createdAt,
    // ApproximateCreationDateTime is millis since epoch; convert for
    // consumers that prefer ISO. Falls back to "now" if absent.
    approximateCreationDateTime: rec.dynamodb?.ApproximateCreationDateTime
      ? new Date(rec.dynamodb.ApproximateCreationDateTime * 1000).toISOString()
      : new Date().toISOString(),
    sequenceNumber: rec.dynamodb?.SequenceNumber,
  };

  return {
    Source: SOURCE,
    DetailType: detailType,
    Detail: JSON.stringify(detail),
    // Explicit EventBusName keeps this off the default bus even if a
    // future maintainer attaches a resource policy that allows it.
    EventBusName: BUS_NAME,
  };
}

/**
 * Lambda's ReportBatchItemFailures contract for DynamoDB streams
 * requires itemIdentifier to be the record's SequenceNumber so the
 * shard iterator can resume correctly on retry. The optional
 * `eventID` field is a UUID useful for logging but is NOT what
 * the runtime expects here.
 */
function streamItemIdentifier(record: DynamoDBRecord): string {
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  if (!sequenceNumber) {
    throw new Error(
      `DynamoDB stream record missing SequenceNumber: ${record.eventID ?? "<unknown>"}`,
    );
  }
  return sequenceNumber;
}

function log(
  level: "info" | "error",
  message: string,
  extra: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    service: "url-shortener-app-bff",
    fn: "trigger",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}