/**
 * URL Mapping entity (Single-Table Design).
 *
 * Stored in MappingsTable. The DDB row shape:
 *   pk         = "url-shortener#MAPPING"
 *   sk         = <code>
 *   ownerSub   = <cognito sub>        (also GSI1 HASH key)
 *   gsisk      = <code>               (also GSI1 RANGE key)
 *
 * GSI1 enables GET /me/urls: query GSI1 with KeyConditionExpression
 * `ownerSub = :sub` to list all mappings owned by the caller.
 *
 * The bus event shape (`detail` field of Mapping.* events) is the
 * `UrlMappingEvent` type below.
 */

export type Discriminator = "MAPPING";

/** Persistence row in MappingsTable. */
export interface UrlMappingRow {
  pk: string;
  sk: string;
  discriminator: Discriminator;
  ownerSub: string;
  gsisk: string;
  code: string;
  longUrl: string;
  /** Optional custom alias (the row's `sk` may equal the alias instead of a random code). */
  alias?: string;
  createdAt: string;
  expiresAt?: string;
  /** Incrementing version for optimistic concurrency on re-imports. */
  version: number;
  /** sha256(IP).slice(0,16) of the original creator (PII-safe, anti-corruption layer). */
  creatorIpHash?: string;
}

/** URL Mapping detail payload carried on EventBridge as `detail` of `Mapping.*`. */
export interface UrlMappingEvent {
  code: string;
  longUrl: string;
  ownerSub: string;
  alias?: string;
  createdAt: string;
  expiresAt?: string;
  version: number;
}

/** Mapping change kind emitted as `detail-type`. */
export type MappingEventType = "MappingCreated" | "MappingUpdated" | "MappingDeleted";
