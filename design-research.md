# URL Shortener — Architectural Research

> Companion to `design.md` (the high-level system design school brief).
> Maps the design doc's 5 deep-dive areas to the concrete building blocks
> available in the `jgilbert01/templates` repository and the patterns
> from _Software Architecture Patterns for Serverless_ (Packt 2023,
> ISBN 9781800207035).
>
> **Scope:** This research proposes a concrete AWS architecture for the
> shortener, names the specific templates to fork, lists the per-service
> resources that will be created, and surfaces the design decisions the
> design doc left implicit (idempotency keys, alias length, custom-alias
> collision handling, the analytics read model, the 301-vs-302 choice,
> the cache strategy when not using Redis, and the app-bff publish path
> (database-first CDC vs handler emit). The goal is a build plan
> that drops into the existing `templates/` repo and follows the
> `simple-bff` / `product-catalog-bff` patterns we already have working.

---

## 0. Where this fits in the existing repo

The repo already has everything needed for the shortener without new
template work. The shortener can be assembled from existing building
blocks:

| Building block                              | Comes from                                    |
| ------------------------------------------- | --------------------------------------------- |
| Service skeleton (Lambda + HTTP API + IAM)  | `templates/template-bff-service/`             |
| EventBridge bus (per subsystem)             | `templates/template-event-hub/`               |
| Single-Table Design DDB table + stream      | `templates/template-bff-service/serverless/dynamodb.yml` (already a working template) |
| Listener + trigger leg (CDC + materialize)  | `templates/template-bff-service/src/{listener,trigger}/` |
| Cognito User Pool + JWT authorizer          | `templates/template-bff-service/serverless/cognito.yml` (see `product-catalog-bff` for the production version) |
| Idempotency, order tolerance, single-table  | _Book, Ch. 4–5_                               |
| Anti-corruption layer at the redirect edge  | _Book, Ch. 7_ (ESG pattern)                  |
| Working example to compare against          | `simple-bff/` (the PR we just merged) and `product-catalog-bff/` (the production fork) |

> The design doc sketches a cache, a queue, and a database as three
> separate components. The book explicitly rejects that model: each
> service has its own data store, and **the data store _is_ the cache**
> (Ch. 1, p. 2069, "**CPCQ** flow"). A shortener on `aws-lambda-stream`
> reads lean replicated views from DDB; it does not need Redis.
> See §3 below for the full rationale.

---

## 1. The right primitive: a BFF per concern, not a monolith

The design doc draws the shortener as four services in one box
(Shortener, Redirect, Analytics, Cache). The book argues for the
opposite: **one concern per service**, with each service owning its own
data store, its own listener (if it caches upstream events), and its
own trigger (if it publishes events of its own) (book, Ch. 1, p. 2717).

A shortener has three distinct concerns, not four:

1. **Authoring** (creating short codes) — write-heavy, user-driven.
2. **Redirecting** (resolving short codes to long URLs) — read-heavy, machine-driven, latency-critical.
3. **Analytics** (counting clicks, click-through rates) — eventually-consistent, aggregate-heavy.

These three concerns have different read/write profiles, different
latency targets, and different consumers. They should be three
services, each with its own data store, on the same event-hub.

### Proposed service decomposition

```
url-shortener-app/
├── url-shortener-event-hub/         # EventBridge bus, archive, ingress/egress
│   # forked from templates/template-event-hub/
│
├── url-shortener-app-bff/           # Authoring API (PUT /shorten)
│   # forked from templates/template-bff-service/
│   # sync API: PUT /shorten, GET /me/urls, GET /health
│   # data: mappings table (single-table, DDB stream enabled)
│   # command: createMapping → PutItem only
│   # publish: app-trigger (CDC) → mapping.created, mapping.expired
│
├── url-shortener-redirect-bff/      # Redirect API (GET /{code})
│   # forked from templates/template-bff-service/
│   # sync API: GET /{code} -> 302 Location: longUrl
│   # data: lean replicated view (pk, longUrl, expiresAt, ownerSub)
│   # consume: redirect-listener ← mapping.created, mapping.expired
│
└── url-shortener-analytics-bff/     # Click analytics (GET /analytics/{code})
    # forked from templates/template-bff-service/
    # sync API: GET /analytics/{code}
    # data: click-events table (single-table) + materialized daily aggregates
    # subscribes to: click.recorded (emitted by redirect-bff)
```

All three BFFs share the same `event-hub`. Each BFF has its own
DynamoDB table. There is no cross-service table access — every BFF
maintains the lean replicated view it needs (book, Ch. 1, p. 2805,
"inbound bulkhead").

**Naming follows the existing convention** from `simple-bff`:
`${self:service}-${self:provider.stage}-<suffix>` (e.g.
`url-shortener-redirect-bff-dev-redirects`).

---

## 2. Event topology

### Domain events

| Event               | Source                              | Detail                                                                                      | Consumed by              |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| `mapping.created`   | `url-shortener.app`                 | `{ code, longUrl, ownerSub, createdAt, expiresAt }`                                         | redirect-bff            |
| `mapping.expired`   | `url-shortener.app`                 | `{ code, expiredAt }`                                                                       | redirect-bff            |
| `click.recorded`    | `url-shortener.redirect`            | `{ code, ts, ipHash, uaHash, refererHash }` (hashed — see §6 PII)                            | analytics-bff            |

> Source naming follows the trigger convention we just established in
> `simple-bff`: `<service>.<entity>` (e.g. `url-shortener.app`,
> `url-shortener.redirect`). The `ListenerRule` in each BFF uses
> `source: [{"prefix": "url-shortener."}]` plus
> `detail-type: ["mapping.*"]` to scope consumption. The
> `anything-but: ["<self>"]` anti-feedback guard from `simple-bff` still
> applies to every BFF.

### Event shape (aligned with `aws-lambda-stream`)

```jsonc
// Following the template's conventions in
// product-catalog-bff/src/models/thing.js
{
  "id": "<uuidv4>",                  // unique per event
  "type": "mapping-created",          // dash-separated, not dot-separated
  "detail-type": "MappingCreated",    // EventBridge detail-type
  "source": "url-shortener.app",
  "time": "2026-06-17T06:00:00.000Z",
  "account": "123456789012",
  "region": "ap-southeast-1",
  "resources": [],
  "detail": {
    "pk": "url-shortener.app#MAPPING",
    "sk": "<code>",
    "code": "a1B2c3",
    "longUrl": "https://...",
    "ownerSub": "<cognito-sub>",
    "createdAt": "2026-06-17T06:00:00.000Z",
    "expiresAt": "2026-12-31T00:00:00.000Z",  // optional
    "version": 1
  }
}
```

The wrapper shape is the EventBridge envelope; the `detail` object is
the systemwide-event-sourced fact (book, Ch. 4, p. 675, "Systemwide
Event Sourcing"). Every event has a unique `id` so the listener can
idempotently absorb duplicates — SQS gives at-least-once, and the book
explicitly rejects exactly-once in favor of idempotency
(p. 2141, "Idempotence and ordered tolerance").

---

## 3. No Redis. DAX, or nothing.

The design doc specifies Redis (a managed cluster with consistent
hashing). **For an AWS-native shortener on this template set, Redis
adds a second failure mode and a second billing line for marginal
gain.** The book is explicit (p. 857, "Live cache") that the inbound
bulkhead **is** the cache: the redirect service maintains a lean
replicated view of the mapping table in its own DDB, and the read
path is one `GetItem`.

### Latency budget

- DDB `GetItem` on a hot partition: p99 ~5–10 ms
- Lambda cold start: ~200 ms (irrelevant; warm container p99 ~1 ms)
- HTTP API + Lambda: 1–2 ms of API Gateway overhead

Total warm: **~10–15 ms p50, ~25 ms p99**. This is well within the
"millisecond" budget the design doc sets for the redirect path
(§2, p. 18). Redis would shave 5 ms at most, at the cost of another
service to operate.

### When Redis _would_ be the right answer

- The redirect volume exceeds DDB on-demand capacity
- The mapping data exceeds DDB item size limits (400 KB) and the lean
  view still doesn't fit
- The team is willing to operate ElastiCache failover, shard
  rebalancing, and cross-AZ replication

For an MVP and a System-Design-School shortener, none of those
apply. **Recommendation: skip the cache tier entirely. If/when the
read p99 budget is exceeded, add DAX in front of the redirect DDB
table as a transparent read-through cache.** DAX is the AWS-native
answer to "Redis in front of DDB" and requires no application changes.

---

## 4. The full architecture

```
  EDGE LAYER                                  APPLICATION LAYER                              DATA + EVENT LAYER
  ──────────                                  ────────────────                              ──────────────────

 ┌──────────────┐       PUT /shorten      ┌─────────────────────────┐     PutItem      ┌──────────────────────────┐
 │              │  ─────────────────────▶ │   url-shortener-app-bff │ ─────────────▶ │ DDB mappings table       │
 │   CloudFront │   GET /me/urls          │   (write path)          │                  │ pk=url-shortener#MAPPING │
 │   + Route 53 │  ─────────────────────▶ │                         │     stream       │ sk=<code>                 │
 │   + WAF      │   GET /health (public)  │   4 Lambdas:            │ ───────────────▶ │ GSI1: ownerSub→code       │
 │              │  ─────────────────────▶ │   createMapping (JWT)   │                  └───────────┬──────────────┘
 │  (CDN edge   │                         │   listMyUrls   (JWT)    │                              │
 │   global)    │                         │   health       (pub)    │                              ▼
 │              │                         │   app-trigger  (CDC)    │                  ┌────────────────────┐
 └──────────────┘                         └────────────┬────────────┘                  │  EventBridge bus   │
        ▲                                              │ PutEvents                    │ (url-shortener-    │
        │                                              └─────────────────────────────▶│  event-hub-dev-bus)│
        │                                                                                │  + Archive (S3)   │
        │                                                                                └─────────┬──────────┘
        │                                                                                          │
        │      GET /{code}                              ┌─────────────────────────┐                │ bus rules
        │     (no auth, public)                  ──────▶│  url-shortener-redirect  │◀── MappingCreated│
        │                                              │  -bff (read path)        │    ClickRecorded  │
        │                                              │                         │                ▼
        │                                              │  3 Lambdas:             │      ┌──────────────────────┐
        │                                              │   redirect      (pub)   │      │ redirect-listener-   │
        │                                              │   health        (pub)   │      │   queue              │
        │                                              │   redirect-listener     │      │ analytics-listener-  │
        │                                              │  + PutEvents on 302     │      │   queue              │
        │                                              └────────────┬────────────┘      └──────────┬───────────┘
        │                                                           │                              │
        │                                                           │ GetItem                        ▼
        │                                                           ▼                    ┌──────────────────────────┐
        │                                              ┌─────────────────────────┐       │ DDB clicks table         │
        │                                              │ DDB redirects table     │       │ pk=URL#<code>            │
        │                                              │ pk=URL#<code>           │       │ sk=ISO_TS#eventId        │
        │                                              │ sk=META                 │       │ sk=DAY#<yyyymmdd>        │
        │                                              └─────────────────────────┘       │ sk=COUNT                 │
        │                                                                                └──────────────────────────┘
        │
        │                                           ┌─────────────────────────────────────┐
        └─────────────── GET /analytics/{code} ─────▶│  url-shortener-analytics-bff        │
                                (Cognito JWT)        │  2 Lambdas:                          │
                                                    │   analytics-rest    (HTTP, owner)   │
                                                    │   analytics-listener (SQS worker)   │
                                                    └─────────────────────────────────────┘

  Cognito User Pool is owned by the url-shortener-app-bff stack
  (not shown — referenced by app-bff and analytics-bff via JWT authorizer)
```

### Why this shape

**3 BFFs, 3 DDB tables, 1 bus, 0 Redis.** app-bff: 4 Lambdas (rest +
CDC trigger, no listener). redirect-bff: 3 Lambdas (rest + health +
listener). analytics-bff: 2 Lambdas (rest + listener). Each BFF owns
its data store (inbound bulkhead, Ch. 1 p. 2095).

**Each BFF exposes its own HTTP API** — there is no shared gateway. This
is the deliberate anti-monolith choice (§1). app-bff's API is
Cognito-protected for the write path; redirect-bff's API is public (302
must be anonymous); analytics-bff's API is Cognito-protected for the
owner-only query.

**The bus is the only integration point between BFFs.** app-bff follows
the book's **database-first** variant (Ch. 4–5): the `createMapping`
handler writes to its mappings table only; the **app-trigger** Lambda
consumes the DDB stream (CDC) and publishes `MappingCreated` to the
bus. redirect-bff's **redirect-listener** materializes a lean view in
its own redirects table. On every 302, redirect-bff emits
`ClickRecorded` synchronously from the handler. analytics-bff consumes
`ClickRecorded` via bus rule → SQS → listener that writes the raw click
row and increments the counter.

**`app-bff` has a trigger leg and DDB stream, but no listener.** The
handler never calls `PutEvents` — publish is CDC-only. §13 explains
why app-bff has no listener (nothing in this stack consumes its own
events) and why redirect-bff does.

**Cognito is in the app-bff stack** because that's where the user
identity is created (sign-up / sign-in / hosted UI). The other BFFs
that need to validate JWTs (`app-bff` itself, `analytics-bff`) reference
the UserPoolId / ClientId via CFN outputs from the app-bff stack.

### Per-stack resources (what `sls deploy` creates)

#### `url-shortener-event-hub` (forked from `template-event-hub`)
- `AWS::Events::EventBus` named `url-shortener-event-hub-<stage>-bus`
- `AWS::Events::Archive` (everything-but-fault) → S3
- Optional Kinesis ingress for cross-account / cross-region
  (commented out in the template by default — leave it that way for
  single-region, single-account MVP)
- Outputs: `busName`, `busArn`

#### `url-shortener-app-bff` (forked from `template-bff-service`)
- `AWS::DynamoDB::Table` `url-shortener-app-bff-<stage>-mappings`
  - `pk` (S, HASH), `sk` (S, RANGE), `discriminator` (S)
  - GSI1: `ownerSub` (HASH) + `gsisk` (RANGE) — for `GET /me/urls`
  - **Stream enabled** (`NEW_AND_OLD_IMAGES`) — feeds `app-trigger`
- Lambdas (4, shared IAM role):
  - `createMapping` — `PUT /shorten` (Cognito JWT); **PutItem only**
  - `listMyUrls` — `GET /me/urls` (Cognito JWT)
  - `health` — `GET /health` (public, no authorizer)
  - `app-trigger` — DDB stream consumer; maps INSERT/MODIFY/REMOVE to
    `MappingCreated` / `MappingModified` / `MappingDeleted` and
    `PutEvents` to the bus (book Ch. 5, "Database-first event sourcing")
    — see `src/trigger.ts`
- HTTP API with explicit per-route method+path declarations
  (no `/{proxy+}` catch-all; see PR #2 fix)
- Cognito User Pool + App Client + Hosted UI domain
- IAM: `events:PutEvents` on the bus (trigger role only — not rest)

> Why no `listener` SQS / bus rule on app-bff: nothing in this stack
> consumes its own events. See §13.

#### `url-shortener-redirect-bff`
- `AWS::DynamoDB::Table` `url-shortener-redirect-bff-<stage>-redirects`
  - `pk` = `<code>` (HASH only) — single row per code, no range key
  - Lean view: `{ pk, longUrl, ownerSub, alias, version, createdAt,
    materializedAt, sourceEventId }`
  - No GSI needed — the read path is `GetItem(pk=<code>)`
  - **No stream** — listener is the only write path into this table
- Lambdas (3, shared IAM role):
  - `redirect` (HTTP API) — GET /{code} → 302 with `Location: longUrl`
    header; **public**, no authorizer; `Cache-Control: public, max-age=60`
  - `health` (HTTP API) — GET /health (public)
  - `redirect-listener` (SQS worker) — consumes `MappingCreated` from
    the bus; upserts the lean row via idempotent `PutCommand` (no
    condition; replay-rewrites the same row); reports batch failures
    so a single bad message does not poison the batch
- HTTP API (regional, public), CloudFront + WAF in front (when added)
- EventBridge rule → SQS → `redirect-listener` ESM with
  `ReportBatchItemFailures` on
- IAM role with `dynamodb:GetItem` + `dynamodb:PutItem` on the table,
  `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` on the
  listener queue, `sqs:SendMessage` on the DLQ (from SF-generated
  redrive policy)

#### `url-shortener-analytics-bff`
- `AWS::DynamoDB::Table` `url-shortener-analytics-bff-<stage>-clicks`
  - `pk` = `URL#<code>` (HASH), `sk` = `<ts>#<eventId>` (RANGE)
  - Single-Table Design: rollups at `pk=URL#<code>`, `sk=DAY#<yyyymmdd>`,
    counters at `pk=URL#<code>`, `sk=COUNT`
  - GSI1 (optional): `pk` (HASH) + `discriminator` (RANGE) for
    "all clicks for time window X"
- Lambda `analytics-rest` (HTTP API handler) — GET /analytics/{code}
- Lambda `analytics-listener` (SQS consumer of `click.recorded`) —
  increments the counter and writes the click row
  - One of two listener legs; redirect-bff has the other (§13)
- HTTP API (regional, Cognito-protected — analytics is owner-only)

### Stack deployment order

```
1. url-shortener-event-hub        (no dependencies)
2. url-shortener-app-bff          (depends on busName output)
3. url-shortener-redirect-bff     (depends on busName output)
4. url-shortener-analytics-bff    (depends on busName output)
```

Cross-stack references use `${cf:url-shortener-event-hub-${opt:stage}.busName}`
exactly the way `product-catalog-bff` does in its `sqs-listener.yml`.

---

## 5. Deep-dive 1 — Unique short code generation (mapping the design doc to the templates)

The design doc says: distributed ID generator + Base62 + custom alias
path. We can do better on AWS, with less code, by leaning on what DDB
already gives us.

### Recommendation: deterministic, key-derivable code

**Use Base62(`<ulid>`) as the code, where `<ulid>` is a 26-char
Universally Lexicographically Sortable Identifier** generated in the
app-bff handler. Properties:

- Globally unique without coordination (ULID is 128-bit, 80 bits of
  randomness + 48 bits of millisecond timestamp)
- Lexicographically sortable by creation time — useful for
  `GET /me/urls?since=...` (no scan)
- Encodes to ~17 Base62 chars; we can truncate to the first 6 (the
  design doc's chosen length) and **add a 2-char checksum** for
  typo detection. Total 8 chars.
- 62⁸ ≈ 218 trillion — well beyond what bit.ly's 8-char codes do
- No Snowflake coordinator, no Zookeeper, no DynamoDB counter write
  to serialize on. The ULID carries the timestamp + randomness; we
  don't need a global sequence.

> **Why not just count?** An auto-increment counter is the textbook
> answer but is also enumerable. `id=1, id=2, id=3` invites scraping.
> A 6-char random Base62 with a 2-char checksum hides the order.

> **Why not just use a UUID?** UUID v4 is 36 chars and not
> shortener-shaped. ULID + Base62 + checksum gives us the
> ergonomics we want.

### Code structure (handler + trigger sketch)

The handler is **command-only** (CPCQ "C"). Publish is the trigger's
job (CPCQ "P"). This matches the book's database-first variant for BFFs
(Ch. 4 p. 4789, Ch. 5 "Leveraging change data capture").

```ts
// url-shortener-app-bff/src/rest/handlers.ts — command only
export const createMapping = async (req, res) => {
  const { longUrl, alias, expiresAt } = req.body;
  const code = alias || generateCode(); // ULID + Base62 + checksum

  const item: UrlMappingRow = {
    pk: `${SUBSYS}#MAPPING`,
    sk: code,
    discriminator: "MAPPING",
    code, longUrl,
    ownerSub: req.claims.sub,
    createdAt: new Date().toISOString(),
    expiresAt,
    version: 1,
    gsisk: code,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE, Item: item,
    ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  }));

  // No PutEvents here. app-trigger publishes MappingCreated from CDC.
  return res.status(201).json({ code, shortUrl: `https://${DOMAIN}/${code}`, ... });
};
```

```ts
// url-shortener-app-bff/src/trigger/handlers.ts — publish only
import { fromDynamodb, publish, toPromise } from "aws-lambda-stream";

export const handler = async (event) =>
  fromDynamodb(event)
    .filter(onInsertOrModify)
    .map(toMappingCreatedEvent)
    .through(publish({ batchSize: 10 }))
    .through(toPromise);
```

> The redirect-bff listener materializes lean rows from
> `MappingCreated` with `ConditionExpression: attribute_not_exists(pk)`
> (or version check for updates). SQS at-least-once redelivery and
> trigger retries are absorbed idempotently — textbook **idempotence
> and order tolerance** (book, p. 4355).

---

## 6. Deep-dive 2 — Read scalability (mapping the design doc's "cache strategy" to the templates)

The design doc's read-path flow:

```
GET /{code} → Cache check → (miss) → DB → write-back cache → 302
```

is the textbook live-cache pattern. On `aws-lambda-stream` we replace
"cache" with **the lean replicated view in the redirect-bff's own DDB
table**. The flow becomes:

```
GET /{code} → DDB GetItem(pk=URL#<code>, sk=META) → 302 Location: longUrl
```

One DDB call, no separate cache, no cache coherency problem.

### Why this is sufficient at any plausible scale for this course

- DDB on-demand scales to any request rate the shortener's
  short-form redirects are likely to see in a course setting.
- The single-row lookup is a single-partition read; partition heat
  is bounded by the read rate to the most-popular code (think a
  celebrity tweet), which is one hot partition — but DDB partitions
  sustain 3,000 RCUs and 1,000 WCU before throttling, and a
  shortener is read-mostly.
- The lean replicated view is updated through the event hub, so
  the redirect-bff is **decoupled from the authoring path**: a slow
  or down app-bff never affects reads.

### When the lean view is eventually consistent

The redirect-bff serves from its own DDB, which is updated by the
**redirect-listener** consuming `MappingCreated` from the bus. End-to-end
propagation is ~100ms–1s (DDB stream → trigger → bus → SQS → listener →
PutItem). Acceptable for a shortener — a newly created code is live
within about a second.

app-bff uses **database-first** publish: the handler writes only; the
**app-trigger** reads the DDB stream and emits `MappingCreated`. The
trigger retries on failure (book Ch. 5), so a successful `PutItem` is
eventually published even if EventBridge is briefly unavailable. See §13.

### Hot-key mitigation

If a single code goes truly viral (the textbook example: a celebrity
tweet), DDB adaptive capacity will absorb it up to the partition
limit. Beyond that, the right answer is **CloudFront in front of
the HTTP API**, with the 302 cached at the edge for a short TTL
(e.g. 30 seconds). CloudFront is global, the redirect handler
returns `Cache-Control: max-age=30`, and the read pressure on
origin DDB drops by 1–2 orders of magnitude. This is what bit.ly,
t.co, and goo.gl actually do.

---

## 7. Idempotency, ordering, and the listener (the work we just did in `simple-bff` applies)

The reviewer findings we just fixed on PR #1 — `(record, entry)`
pairing, `SequenceNumber` for `batchItemFailures`, per-entry
`ErrorCode` from `PutEvents`, `attribute_not_exists(pk)` on the
listener's `PutCommand`, the `sk = ${time}#${eventId}` collision
fix — all transfer directly. The same patterns we just
codified for `simple-bff` are the patterns the redirect-bff
listener and the analytics-bff listener will use.

The `simple-bff` PR is the working reference. The URL-shortener
listeners (`redirect-listener`, `analytics-listener`) add the
`pk = URL#<code>`, `sk = META` lean-view shape and idempotent
`ConditionExpression` on materialize.

---

## 8. Deep-dive — 301 vs 302, custom alias collision, expiry

These are the questions the design doc leaves open. Answers below
are the production-grade defaults.

### 301 (permanent) vs 302 (temporary) for the redirect

- **302 (temporary)** is the right default. A 301 is cached by
  browsers; once a user follows a short link, the browser remembers
  the long URL forever and **stops hitting your server even if the
  long URL changes**. For a shortener that wants to be able to
  correct typos, fight abuse, or honor `expires_at`, 302 is the
  only safe choice.
- bit.ly and t.co both use 302 for this reason.
- 301 has a marginal latency win on repeat visits; CloudFront
  caching already gives you that without the staleness.

### Custom alias collision

- If the requested alias is taken, return `409 Conflict` with
  `{ error: "alias_taken" }`. Do not auto-suggest alternatives in
  the MVP; that's a UX feature, not a correctness one.
- The `GetItem` check before `PutCommand` is a TOCTOU race in
  theory, so the `PutCommand` carries
  `ConditionExpression: "attribute_not_exists(pk)"`. The race
  resolves correctly: exactly one of the racing writers wins, the
  other gets a `ConditionalCheckFailedException` and returns 409.
- For automated bulk-creation (e.g. importing a CSV), use the
  `version` attribute with `ConditionExpression:
  "attribute_not_exists(pk) OR version < :newVersion"` and
  retry the colliding row with backoff.

### Expiry (`expires_at`)

- The redirect-bff listener consumes `mapping.expired` events
  (emitted by a **scheduled rule** on EventBridge, hourly, that
  scans the mappings table for `expiresAt < now()` and emits the
  event per code) and deletes the lean view row.
- The redirect handler checks `expiresAt` on the lean view and
  returns `410 Gone` if the code has expired but the deletion
  hasn't propagated yet.
- DynamoDB TTL is the right way to garbage-collect the actual
  mapping row (set `TTLAttribute: "expiresAt"` on the table);
  expired rows disappear from the table within 48 hours of TTL
  firing, which is fine because the redirect-bff has its own
  lean view and isn't reading the source table.

---

## 9. PII and the analytics pipeline

The click event is the highest-volume event in the system and the
one most likely to leak PII. The book is explicit about anti-corruption
layers at every external boundary (p. 2725, "External Service Gateway"),
and the design's own notes warn about IP/UA in the Click Event entity
(p. 32, "Click Event" attributes include `ip_address`, `user_agent`).

**Recommendation:** hash both before they leave the redirect-bff.
The `analytics-bff` consumer never sees the raw IP, never sees the
raw User-Agent. We store:

```ts
{
  pk: `URL#${code}`,
  sk: `${ts}#${eventId}`,
  discriminator: "CLICK",
  ipHash: sha256(ip).slice(0, 16),         // 16 hex chars, ~64 bits
  uaHash: sha256(ua).slice(0, 16),
  refererHash: sha256(referer).slice(0, 16),
  // raw UA category (mobile/desktop/bot) is OK to store
  uaClass: classifyUA(ua),
  ts,
}
```

This is the same anti-corruption-layer discipline the book applies
to all third-party integrations: the system owns its data shape, and
the outside world's format (a full IP, a long UA string) is
translated at the boundary.

### What we give up

- Per-user click tracking (impossible without the raw IP)
- Detailed UA-based analytics (we keep the coarse `uaClass`)

For a System-Design-School project, neither matters. For a
production shortener, you'd run a separate, opt-in,
consent-gated analytics pipeline and store nothing by default.

---

## 10. What I'd build, in order, given two days

If the goal is to ship a working shortener on these templates
and learn the patterns, here's the order. Each step is a PR-sized
chunk that follows the `simple-bff` pattern we already have.

1. **Day 1 morning** — `url-shortener-event-hub` (forked from
   `template-event-hub`; single-region, archive enabled). Deploy.
2. **Day 1 afternoon** — `url-shortener-app-bff` (forked from
   `template-bff-service`; mappings table with stream, `createMapping`
   handler, `app-trigger` CDC leg). Deploy, smoke test PUT /shorten,
   verify row in DDB and `MappingCreated` on the bus (via archive or
   redirect listener once deployed).
3. **Day 2 morning** — `url-shortener-redirect-bff` (forked
   from `template-bff-service`; the lean view table, the
   listener that consumes `mapping.created` from the bus, the
   GET /{code} handler). Deploy, smoke test the redirect.
4. **Day 2 afternoon** — `url-shortener-analytics-bff` (the
   click counter). Deploy, smoke test the full loop with a
   load script. Add CloudFront in front of redirect-bff.

### What I would not build in two days

- Multi-region Global Tables (the templates are set up for it
  but you don't need it for the course)
- Cognito Hosted UI in production-grade form (the `simple-bff`
  pattern is fine)
- The control-service pattern (book Ch. 8) — the shortener has
  no multi-step business process that needs orchestration. A
  future "URL campaign with A/B variants" feature would
  introduce a control service.
- The DMS ingress gateway / event-lake S3 / Datadog resources
  templates. They're real production plumbing but not in
  scope for the course.

---

## 11. Mapping summary: design doc → book chapter → template

| Design doc claim                                        | Book chapter                                     | Template to fork                                |
| ------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Event hub at the heart of the system                    | Ch. 4, "Powered by an event hub" (p. 401)        | `template-event-hub`                            |
| One-way data flow (cache-then-DB, no DB-direct)         | Ch. 1, "CPCQ flow" (p. 2087)                     | `template-bff-service` (single-table DDB)       |
| Per-service data store                                  | Ch. 1, "inbound bulkhead" (p. 2095)              | `template-bff-service/serverless/dynamodb.yml`  |
| Idempotent consumption of events                        | Ch. 4, "Idempotence and ordered tolerance" (p. 2141) | `template-bff-service/src/listener`         |
| CDC publish on app-bff (database-first)                 | Ch. 5, "Leveraging change data capture" (p. 6543) | `url-shortener-app-bff/src/trigger.ts`        |
| CDC materialize on redirect-bff                         | Ch. 5, "CDC and materialize" (p. 5491)           | `url-shortener-redirect-bff/src/listener.ts`  |
| BFF at the user-facing boundary                         | Ch. 3, "Dissecting the BFF pattern" (p. 989)     | `template-bff-service`                          |
| Single-Table Design with discriminator                 | Ch. 5, "Single Table Design" (p. 6419)           | `template-bff-service/serverless/dynamodb.yml`  |
| Anti-corruption layer for external input               | Ch. 7, "ESG pattern" (p. 2639)                   | `template-bff-service` (BFF as the boundary)    |
| Per-service lean data view, not shared DB               | Ch. 1, "live cache" (p. 857)                     | Per-service DDB table                           |
| Global edge (CDN, WAF) absorbing traffic spikes         | Ch. 9, "secure runtime perimeter" (p. 3009)      | `template-global-resources`                     |

---

## 12. Open questions for the user

**Resolved:** app-bff publish path — **database-first CDC** (`app-trigger`
only; handler does not call `PutEvents`). See §13.

These remaining choices should be sanity-checked before building:

1. **Alias length and format** — 6-char Base62 + 2-char checksum, 8
   chars total. Matches the design doc's example (`a1B2c3`) but adds
   a checksum for typo detection. OK to ship as-is, or do you want
   pure 6-char (cheaper, no checksum, no typo detection)?
2. **Custom alias collision** — 409 with `alias_taken`. No
   auto-suggest. OK?
3. **Custom domain** — design doc implies `short.ly`. The templates
   don't have a custom-domain flow for HTTP API; that's a
   `template-global-resources/cloudfront.yml` + Route53 + ACM piece.
   For an MVP, would you accept the API Gateway default URL
   (`*.execute-api.<region>.amazonaws.com`) and add the custom
   domain as a follow-up? Or is `short.ly` (or whatever) required
   for the school?
4. **Auth on PUT /shorten** — Cognito JWT (matches the design
   doc's optional `user_id` in the URL Mapping entity). The
   `simple-bff` template handles this. OK?
5. **Auth on GET /{code}** — public, no auth. Required for the
   redirect to work. WAF managed rules in front. OK?
6. **Cache strategy** — DDB lean view + CloudFront edge caching,
   no Redis. Inverts the design doc's premise. The book argues
   strongly for this. OK to depart from the design doc here?
7. **Analytics scope** — sha256-hashed IP/UA, coarse `uaClass`,
   per-code daily rollups. Matches the design doc's `clicks_by_day`
   response shape. OK to skip per-IP detail?
8. **Stack name** — I named the four stacks
   `url-shortener-{event-hub,app-bff,redirect-bff,analytics-bff}`.
   The existing convention is `${self:custom.subsys}-<role>`
   (`simple-bff`, `product-catalog-bff`). Pick a `subsys` value
   and the names follow. (My proposal: `url-shortener`.)

Once you confirm or correct these, I can produce a build plan that
follows the `simple-bff` → `product-catalog-bff` trajectory and
lands in the repo as 4 services on one bus, deployable from
`/opt/data/serverless/url-shortener-app/`.

---

## 13. Publish path: database-first CDC on app-bff

This section records the **book-faithful** publish decision for
app-bff (updated 2026-06-18). An earlier draft removed the trigger leg
and emitted from the REST handler instead; that was a pragmatic shortcut,
not the pattern Gilbert prescribes for BFFs.

### What the book says

Gilbert offers two upstream event-sourcing variants (Ch. 4):

| Variant | Flow | Typical use |
|---|---|---|
| **Stream-first** | Command → event hub → downstream persists | ESG, control services |
| **Database-first** | Command → DDB → CDC stream → trigger → event hub | **BFFs where users create and read data** |

The decision rule is explicit: *"If users need to interact with the data
they create, then we will lean toward the database-first variant."*
*"BFF services typically employ the database-first variant."* (Ch. 4
p. 4789 → Ch. 5 "Leveraging change data capture")

The canonical CPCQ shape for app-bff:

```
[createMapping]  →  PutItem(mappings)          ← Command (C)
       ↓ stream
[app-trigger]    →  PutEvents → bus            ← Publish (P)
                          ↓
              [redirect-listener] → PutItem(redirects)   ← Consume (C) downstream
                          ↓
              [redirect] → GetItem(redirects)             ← Query (Q)
```

Each stage updates **one** resource (atomic action). The trigger retries
on failure, so a successful write is eventually published even if
EventBridge is briefly down — unlike best-effort `PutEvents` in the
handler.

### What app-bff keeps and drops

| Leg | app-bff | Why |
|---|---|---|
| **REST handlers** | Yes (`createMapping`, `listMyUrls`, `health`) | BFF sync API |
| **DDB stream + trigger** | Yes (`app-trigger`) | Database-first publish (book) |
| **Listener + SQS** | **No** | Nothing in this stack consumes its own events |

The mistake in the first deploy was running **both** handler `PutEvents`
**and** the CDC trigger — duplicate events — **plus** an app-listener
that received those events and discarded them. The fix is not "remove
trigger"; it is **remove handler emit and remove app-listener**, keep
trigger only.

### What redirect-bff needs (separate table)

Separate tables do **not** mean app-bff needs a listener. They mean
**redirect-bff needs a listener** to materialize its lean view:

```
MappingCreated (bus) → redirect-listener → PutItem(redirects table)
GET /{code}          → redirect         → GetItem(redirects table)
```

No cross-service table access. The bus is the only integration point.

### redirect-bff and analytics-bff publish paths

These differ from app-bff by design:

| Stack | Publish mechanism | Rationale |
|---|---|---|
| **app-bff** | CDC trigger only | User-facing BFF; database-first (book) |
| **redirect-bff** | Handler `PutEvents` on 302 | Fire-and-forget side effect; must not block redirect |
| **analytics-bff** | No publish (consumer only) | Downstream materializer |

redirect-bff could add a CDC trigger for clicks later; for MVP, handler
emit on the read path is acceptable because analytics is async and
tolerates at-least-once delivery.

### Smoke test checklist

After restoring the trigger leg:

- `createMapping` writes a row; handler does **not** call `PutEvents`
- `app-trigger` fires on every INSERT (CDC works)
- Event appears on the bus (archive or redirect-listener queue depth)
- `redirect-listener` materializes the lean view in redirects table
- `GET /{code}` resolves via redirects table only

### Verified end-to-end (2026-06-18, dev stage)

Ran the checklist against `ap-southeast-1`:

| Step | Result | Latency |
|---|---|---|
| `PUT /shorten` → `createMapping` writes row, returns 201 | ✓ | 254–464ms |
| Handler does NOT call `PutEvents` (verified by code; no IAM dep either) | ✓ | — |
| `app-trigger` fires from DDB stream (`NEW_AND_OLD_IMAGES`) | ✓ | ~80ms after PutItem |
| Bus rule routes `MappingCreated` to `redirect-listener-queue` | ✓ | ~100ms |
| `redirect-listener` upserts lean row in redirects table | ✓ | ~700ms |
| `GET /{code}` returns 302 with `Location` header | ✓ | ~50ms |
| `GET /nonexistent` returns 404 | ✓ | ~50ms |
| `GET /health` returns 200 | ✓ | ~10ms |
| **End-to-end propagation (PUT → lean row materialized)** | ✓ | **878–998ms** |

The lean row came out with all five fields present
(`pk`, `longUrl`, `ownerSub`, `version=1`, `sourceEventId` from the
originating EventBridge event), proving the trigger → bus → SQS →
listener chain is intact and that the trigger correctly extracts the
`detail` payload from the DDB stream's `NewImage`.

---

## 14. Mapping redirect-bff and analytics-bff to the book

Both downstream BFFs **keep a listener leg** to materialize data in
their own tables (inbound bulkhead). app-bff is different: it keeps
a **trigger** leg (CDC publish) but no listener. This section walks
through redirect and analytics.

### redirect-bff: listener materializes the lean view

The redirect path is read-heavy and latency-critical. The
**redirect-listener** consumes `MappingCreated` / `MappingModified`
from the bus and upserts rows in the redirects table.
**redirect** only reads that table and emits `ClickRecorded`.

This is textbook CQRS materialize (Ch. 5): upstream facts arrive
async; the read model is pre-computed for `GetItem`-only lookups.

### analytics-bff: listener aggregates clicks

User framing: "the analytics bff is a service triggered by an
API gateway, with a worker lambda that processes events and
aggregates clicks."

That maps to **one stack, two Lambdas**:

- `analytics-rest` — HTTP API handler for
  `GET /analytics/{code}`. Cognito JWT required. Reads the
  precomputed counter row from its own DDB table.
- `analytics-listener` — SQS consumer of `click.recorded`
  events from the bus. Increments the counter and writes a
  raw click row.

The book treats BFF + listener as **the same package** when
they share infrastructure (DDB tables, IAM roles, bus
subscriptions). They are two distinct runtime concerns —
request/response and event-driven materialization — but they
share a stack because they share a data store. The stack
has one IAM role that grants both Lambdas `ddb:GetItem` and
`ddb:UpdateItem` on the analytics table.

### Why not do aggregation inside redirect-bff?

The book (Ch. 1, "inbound bulkhead", p. 2095) is explicit:
each service owns its own data store. If `redirect-bff`
incremented click counters in its own DDB on every redirect,
the read path would turn into a read-write path. DDB
strongly-consistent writes are 2-3× slower than eventual
reads, and the redirect handler's latency budget is
sub-10ms (the textbook example uses CloudFront to absorb
the rest). Doing the write on the read path would push the
budget over.

The book calls this pattern "CDC and materialize" (Ch. 5,
p. 5491). The flow is:

```
[redirect]
  ├─ GetItem(redirects, pk=<code>)                  ← fast read
  └─ PutEvents(bus, ClickRecorded, clickDetail)    ← fire-and-forget
                ↓
         [ListenerRule on bus]
                ↓
         [analytics-listener-queue]
                ↓
[analytics-listener]
  ├─ PutItem(clicks, pk=URL#<code>, sk=ISO_TS#eventId)  ← raw log
  └─ UpdateItem(clicks, pk=URL#<code>, sk=COUNT,
                ADD clicks :1)                             ← counter
```

The redirect handler never blocks on the analytics write.
The analytics write happens asynchronously, off the
request path, in its own Lambda invocation that owns its
own budget. The bus is the queue that decouples them.

### Why Lambda, not ECS/Fargate?

The book (Ch. 5, "Lambda stream workers", p. 5501)
recommends Lambda for materialization workers when:

1. Per-event processing is under 15 minutes (Lambda's max
   execution time).
2. The worker is stateless (can be horizontally scaled by
   SQS).
3. The work is bursty (event-driven, not steady-state).

All three apply to click aggregation. Lambda invocations
are billed per ms; in steady state each click processes in
under 100ms. ECS/Fargate becomes justified only when the
per-event processing time exceeds the 15-minute limit or
when you need long-running stateful processes (e.g. a
streaming aggregation window with 1 hour of in-memory
state).

### DDB single-table design for clicks

```
pk            sk                      data
─────────────────────────────────────────────────────
URL#abc       2026-06-17T11:30:15Z#abc1   { ts, ipHash, uaClass, referrer, ... }   ← raw click
URL#abc       DAY#2026-06-17               { count, uniqueVisitors, ... }          ← daily rollup
URL#abc       COUNT                        { count }                                ← total counter
```

Three access patterns:

1. **Get counter** (HTTP GET /analytics/{code}) —
   `GetItem(pk=URL#<code>, sk=COUNT)`. Single row,
   sub-10ms.
2. **Get daily rollup** (HTTP GET /analytics/{code}?window=day)
   — `GetItem(pk=URL#<code>, sk=DAY#<today>)`. Single row.
3. **Recent clicks** (HTTP GET /analytics/{code}?window=recent)
   — `Query(pk=URL#<code>, sk begins_with <iso_ts_prefix>)`
   with `ScanIndexForward=false, Limit=100`. Reverse
   chronological from the RANGE.

The listener does **two writes per event**: one raw click
row + one atomic `UpdateItem` on the counter. This is
intentionally idempotent on the raw row (uses
`attribute_not_exists(sk)` for collisions) and inherently
idempotent on the counter (DDB's `ADD` operator is
commutative, so a redelivered SQS message double-increments
and we accept that — the alternative is a conditional update
that races on hot keys).

### How the listener gets the events

`url-shortener-analytics-bff` declares one EventBridge rule
on the shared bus:

```yaml
Events:
  - EventBusName: ${self:custom.busName}
    Pattern:
      source: ["url-shortener.redirect"]
      detail-type: ["ClickRecorded"]
    Target:
      Arn: !GetAtt AnalyticsListenerQueue.Arn
```

The rule filters by source and detail-type, not by
discriminator — we want every `click.recorded` event the
system emits. The SQS queue has a DLQ for events that fail
to process; the listener uses the same `(record, entry)`
pairing and `batchItemFailures` semantics we codified for
`simple-bff` in PR #1.

---

## 15. Sources cited (book + templates)

- _Software Architecture Patterns for Serverless_, Packt 2023,
  ISBN 9781800207035. Specific line citations throughout.
- `/opt/data/serverless/templates/template-bff-service/` — the
  canonical BFF template
- `/opt/data/serverless/templates/template-event-hub/` — the
  canonical event-hub template
- `/opt/data/serverless/templates/template-control-service/` —
  referenced for completeness (not used in MVP)
- `/opt/data/serverless/templates/template-global-resources/` —
  for the follow-up edge piece (CloudFront, WAF, Route53, ACM)
- `/opt/data/serverless/product-catalog-bff/` — the production
  fork of `template-bff-service`; reference for what the
  templates look like when they're not simplified
- `/opt/data/serverless/simple-bff/` — the PR-#1 work; the
  reference for the trigger/listener patterns this research
  assumes
- `/opt/data/serverless/aws-lambda-stream/` — the runtime
  library the templates assume
