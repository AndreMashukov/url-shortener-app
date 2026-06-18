EventBridge to SQS delivery broken in url-shortener monorepo (ap-southeast-1)
2026-06-18, analytics-bff smoke test

Status: open. Two of the four stacks are affected: url-shortener-redirect-bff listener
queue stays at zero, url-shortener-analytics-bff clicks listener queue stays at zero.
Both queues are wired to EventBridge rules on the shared bus and have correct resource
policies. The bus archive reports only three historic events (from the very first
MappingCreated smoke test on 2026-06-17), which suggests cross-rule delivery is
silently failing for newer events.

What has been verified

1. The bus exists. Name is url-shortener-event-hub-dev-bus, deployed by the
   url-shortener-event-hub stack (serverless/bus.yml, type AWS::Events::EventBus).
   No resource policy was authored in that stack, so the bus should fall back to
   the default behavior (account principal has full control, plus any conditions
   AWS applies implicitly).

2. The app-bff trigger lambda DOES fire and DOES call PutEvents successfully.
   CloudWatch logs from url-shortener-app-bff-dev-trigger at 2026-06-18T02:55:58
   show: trigger invoked, recordCount=1, trigger chunk ok chunkSize=1,
   trigger done succeeded=1 failed=0. So the event reached EventBridge from the
   producer side.

3. The redirect-bff ClickRecorded emit function also calls PutEvents
   successfully. I rewrote the handler three times to rule out fire-and-forget
   cancellation issues: first as void (fire-and-forget), then as await, then as
   await with throw on failure. In all three deployments the handler returned 302
   (not 500) and the lambda log stream contained no console.warn or console.error
   lines. So the SDK call returns success.

4. The redirect-bff redirect lambda is being invoked and returns 302 within
   25 to 60 ms duration. That is consistent with one DDB GetItem but not with a
   DDB GetItem plus a PutEvents network round trip. This is the strongest signal
   that either the PutEvents call is being optimized out, or the response is
   being returned before the call actually completes (despite the await).

5. The two bus rules are ENABLED in EventBridge.
   url-shortener-redirect-bff-dev-mapping-created targets
   arn:aws:sqs:ap-southeast-1:579273601730:url-shortener-redirect-bff-dev-listener-queue
   url-shortener-analytics-bff-dev-clicks-listener-rule targets
   arn:aws:sqs:ap-southeast-1:579273601730:url-shortener-analytics-bff-dev-clicks-listener-queue
   Both targets have DeadLetterConfig pointing at the matching DLQ. Neither has a
   RoleArn, which is correct for same-account same-region SQS targets.

6. The SQS queue policies are correct. Both queues allow
   events.amazonaws.com to sqs:SendMessage, conditioned on aws:SourceArn
   matching the specific rule ARN. The policies were written by the
   ClicksListenerQueuePolicy and the redirect-bff equivalent, both deployed as
   CREATE_COMPLETE.

7. The DLQs are empty. So the rules are not failing with delivery errors; they
   are simply not firing at all (or firing but the messages are vanishing before
   hitting SQS).

8. Direct boto3 put_events test from the host also returned FailedEntryCount 0
   but the analytics queue stayed at zero. That confirms the bus accepts the
   event and silently does not route it to the matching rule.

Most likely root causes

(a) The bus resource policy is missing or has an implicit deny. Without an
    explicit resource policy, an EventBridge bus defaults to allowing the AWS
    account principal, but cross-rule invocation between stacks in the same
    account is normally fine. The most likely failure mode here is a misconfigured
    Condition on the bus policy that blocks events from reaching rules that were
    created by stacks other than the one that owns the bus. To verify, inspect
    aws events describe-event-bus --name url-shortener-event-hub-dev-bus and look
    at the Policy field. If it is empty, this is unlikely. If it has statements,
    check for conditions like aws:SourceAccount, aws:SourceArn, or
    aws:PrincipalOrgID.

(b) The archive is somehow short-circuiting delivery. The archive rule is
    defined as a separate AWS::Events::Rule targeting the archive resource, and
    the archive itself is a passive sink (it does not consume events). The
    archive filter is {"detail":{"type":[{"anything-but":"fault"}]},
    "replay-name":[{"exists":false}]}. Events without a detail.type field
    (which is the case for our MappingCreated and ClickRecorded events) would
    not match the archive filter, but they would still be evaluated against the
    SQS rules. So the archive is probably not the cause. To rule it out, the
    archive EventCount is 3 and we can see exactly 3 events that should be
    archived have been archived (those from 2026-06-17). All newer events are
    not in the archive. That is consistent with newer events not even reaching
    the archive evaluation stage, so the archive itself is fine.

(c) Account-level EventBridge throttling or quota. ap-southeast-1 has a
    PutEvents quota of about 10,000 per second per account. We are nowhere
    near that. So throttling is extremely unlikely.

(d) The redirect-bff and analytics-bff rules were created in stacks that
    somehow lost permission to put events on the bus. The redirect-bff
    MappingCreated rule was created on 2026-06-17 (with the redirect-bff
    stack) and worked then. The analytics-bff clicks rule was created on
    2026-06-18 (with the analytics-bff stack). It is possible the older rule
    worked at one point and is now also broken because the bus policy changed.
    To verify, replay the archive (StartReplay) targeting the most recent
    30 days of events to a temporary rule and see if the rule fires.

Next diagnostic steps

Step 1. Inspect the bus resource policy.
  aws events describe-event-bus --name url-shortener-event-hub-dev-bus --region ap-southeast-1
  Look for the Policy field. If non-empty, check for explicit Deny or
  conditional Allow on the rule principal.

Step 2. Verify the rule's target permission.
  aws events list-targets-by-rule --rule url-shortener-redirect-bff-dev-mapping-created --event-bus-name url-shortener-event-hub-dev-bus
  Confirm Arn is the SQS ARN.

Step 3. Replay the archive to a fresh rule and a new SQS queue.
  Pick a recent event from the archive. Start a replay. Wire the replay
  destination rule to a fresh SQS queue. Watch for delivery.

Step 4. Re-deploy the event-hub stack with an explicit resource policy that
  explicitly allows events.amazonaws.com to PutEvents. Even though this is
  usually implicit, adding it removes one variable.

Step 5. As a last resort, recreate the bus. Delete the url-shortener-event-hub
  stack and redeploy. Rules in dependent stacks will need to be re-evaluated
  because their parent bus will be gone, but the rules themselves live in
  their own stacks and will be reattached.

Impact

All event-driven flows in the monorepo are blocked. The lean view
materialization in redirect-bff needs to be disambiguated before we can
scope the impact properly: if materialization is happening through the SQS
listener, it should be broken right now; if materialization is happening
through some other path (DDB streams writing directly, or a backfill), then
only analytics-bff is affected.

Documentation pointer

This doc lives at docs/eventbridge-sqs-delivery-issue.md in the
url-shortener-app monorepo root. It is intentionally written as a working
note for the next session, not as a long-term architectural document. Once
the root cause is identified, the fix should be captured in design-research.md
section 4 (event-hub design) and the relevant rules added to the
nx-monorepo-serverless-stack skill (see the verify pipeline section in that
skill).
