// Placeholder entrypoint for url-shortener-event-hub.
//
// This stack is pure infrastructure (an EventBridge bus + an event
// archive). It has no Lambda functions and no business logic. This
// file exists so the project's TypeScript build has at least one
// `.ts` input to validate, satisfying `tsc --noEmit`.
//
// Future: when we add per-stack domain types in libs/shared-types,
// this file can re-export them.

export const EVENT_HUB_STACK_NAME = "url-shortener-event-hub";
export const EVENT_HUB_STACK_DESCRIPTION =
  "EventBridge bus + archive; shared by app-bff, redirect-bff, analytics-bff";
