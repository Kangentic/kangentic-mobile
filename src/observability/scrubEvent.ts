import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

/**
 * Breadcrumb categories this app allows through to Sentry, default-deny
 * rather than default-allow: an unanticipated category (a native SDK
 * breadcrumb this list did not plan for) must be dropped, not silently
 * forwarded. 'sentry.event' is Sentry's own "an event was sent" bookkeeping
 * breadcrumb, the one category the app's breadcrumbsIntegration options
 * leave enabled.
 */
const ALLOWED_BREADCRUMB_CATEGORIES = new Set<string>(['sentry.event']);

export function allowlistBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category !== undefined && ALLOWED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) {
    return breadcrumb;
  }
  return null;
}

/**
 * Removes fields Sentry does not need for a crash report from an
 * accountless, E2E-encrypted app: no per-device user identity, no captured
 * HTTP request (this app makes none through Sentry's instrumentation, but
 * the field exists on every event), no arbitrary `extra`, no server name
 * (this app has no server), no captured HTTP response context.
 *
 * WHAT THIS CANNOT DO, AND WHY: an event's stack frames cannot be scoped by
 * source file here. Under Expo, @sentry/react-native's rewrite-frames
 * integration replaces every frame's `filename` with one constant bundle
 * name (`app:///index.android.bundle` / `app:///main.jsbundle`) before
 * beforeSend ever runs - real source paths are resolved only server-side,
 * after ingestion, from the uploaded source map. A per-module redaction
 * rule ("if the top frame is under src/notifications/, redact the
 * message") is therefore not implementable on-device and is not attempted.
 *
 * What keeps src/pairing/**, src/channel/** and src/notifications/**
 * content out of Sentry is upstream of this function: those directories
 * cannot import Sentry at all (ESLint-enforced, see
 * .claude/rules/crash-reporting-scope.md), and their own long-standing
 * convention is to catch and discard every error without logging or
 * rethrowing it (.claude/rules/e2e-notification-privacy.md).
 *
 * That is a partial guard, not an invariant, and this comment used to
 * overstate it. The import ban only stops a DELIBERATE capture call; an
 * error from those directories that escapes uncaught is still picked up by
 * the global handler and arrives here with its message intact, because
 * `exception.value` is deliberately never touched (reporting the message is
 * the point). EXPECTED_TRANSPORT_NOISE in crashReporting.ts exists exactly
 * because channel errors do arrive today. The rule file names this gap.
 */
/**
 * The second line behind reportHandledError (crashReporting.ts). An event
 * tagged `site` came through the handled-error door, whose contract is that
 * no message text leaves; the door already sends a synthetic message, and
 * this makes the contract hold even if a future edit captures the original
 * by mistake. Every value is rewritten, not just the first: the
 * linked-errors integration appends one entry per `cause`. Keyed on `site`
 * and nothing else - the boundary path tags `errorBoundary` and keeps its
 * message on purpose, because a render throw's message is app-authored.
 */
function redactHandledExceptionValues(event: ErrorEvent): ErrorEvent {
  const site = event.tags?.site;
  if (typeof site !== 'string' || event.exception?.values === undefined) return event;
  return {
    ...event,
    exception: {
      ...event.exception,
      values: event.exception.values.map((entry) => ({ ...entry, value: `handled at ${site}` })),
    },
  };
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const {
    user: _user,
    request: _request,
    extra: _extra,
    server_name: _serverName,
    contexts,
    ...rest
  } = redactHandledExceptionValues(event);
  if (contexts === undefined) return rest;
  const { response: _response, ...scrubbedContexts } = contexts;
  // Omit `contexts` rather than sending an empty object, including when
  // `response` was its only key. An empty container is not the same claim as
  // an absent one to anything reading the payload later.
  if (Object.keys(scrubbedContexts).length === 0) return rest;
  return { ...rest, contexts: scrubbedContexts };
}
