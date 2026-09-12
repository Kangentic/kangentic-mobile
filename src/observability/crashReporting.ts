import * as Sentry from '@sentry/react-native';
import { isCapabilityVerb, type CapabilityVerb } from '@kangentic/protocol';
import { allowlistBreadcrumb, scrubEvent } from './scrubEvent';

/**
 * Crash and error reporting. Deliberately narrow: this app reports that it
 * broke and where in the code, and nothing about what the user was doing or
 * what their agent session contained.
 *
 * WHY THE CONTROLS LOOK LIKE THIS. A JavaScript `beforeSend` hook does NOT
 * filter native events - a hard iOS/Android crash is captured and sent by
 * sentry-cocoa / sentry-android and never passes through the JS layer at
 * all. So every control here is set at its SOURCE (an integration removed,
 * a feature disabled) rather than in a scrubber, because a scrubber cannot
 * reach the native path. This matters most for breadcrumbs: JS breadcrumbs
 * are synced into the native scope, so a console breadcrumb captured in JS
 * rides a native crash straight past `beforeSend`. Console breadcrumbs are
 * ON by default, which is why they are turned off explicitly below.
 *
 * KNOW WHERE THAT ARGUMENT STOPS. Only some of these options reach native.
 * `@sentry/react-native` destructures `beforeSend`, `beforeBreadcrumb` and
 * `integrations` out of the options before calling `initNativeSdk` (see
 * dist/js/wrapper.js), so the breadcrumb hardening below governs the JS
 * scope ONLY. sentry-android keeps its own default auto-breadcrumbs and
 * those ride a native crash unfiltered. Observed directly on a delivered
 * payload, not inferred: `app.lifecycle` (foreground/background),
 * `device.event` (battery level, charging, screen on/off), and
 * `network.event` (action, network type, VPN active, signal strength, and
 * up/down bandwidth). sentry-cocoa does the same: `started` and
 * `ui.lifecycle` were observed on the first iOS event the project received
 * (2026-09-12), and on a JS-CAPTURED event at that, because the SDK's
 * device-context integration merges the native scope's breadcrumbs into
 * every JS event before `beforeSend` - which is why scrubEvent applies the
 * allowlist to `event.breadcrumbs` as well. They carry no session content,
 * but do not read the block below as covering a NATIVE crash's breadcrumbs:
 * closing that needs native config through a config plugin. A crash the OS
 * catches also carries a
 * per-install identifier (`contexts.device.id`, promoted into `user.id`)
 * that `sendDefaultPii: false` does not stop and `scrubEvent` never sees;
 * it is disclosed in docs/privacy-policy.md rather than suppressed.
 * Same story for iOS app-hang and watchdog-termination reporting,
 * left at their native defaults (on) deliberately, because a hang and an
 * out-of-memory kill are the app breaking, which is what this reports.
 * `sendDefaultPii`, `attachScreenshot`, `attachViewHierarchy`,
 * `maxBreadcrumbs`, `ignoreErrors` and `enableAutoSessionTracking` DO reach
 * native (RNSentryModuleImpl.java bridges each explicitly). `ignoreErrors`
 * is the one to read carefully: wrapper.js DOES list it in the destructure
 * that strips options, so it looks stripped, but the lines just above that
 * first translate it into `ignoreErrorsStr` / `ignoreErrorsRegex`, and those
 * survive. The effect reaches native; only the key name changes. One real
 * limit falls out of that translation - it keeps strings and RegExps only,
 * so a function predicate would filter in JS and not natively.
 *
 * See docs/security.md and .claude/rules/crash-reporting-scope.md.
 */

/**
 * Errors that are normal operating conditions on a phone, not defects. A
 * mobile app loses its socket constantly (tunnel, lift, screen off). Left
 * unfiltered these alone would exhaust the free tier's 5,000 events/month
 * without describing a single real bug.
 *
 * The last two match `src/channel/relayTransport.ts` verbatim (lines 137,
 * 142, 164, 190). The first does NOT come from this repo at all: "Network
 * request failed" is React Native's own networking-bridge message for a
 * failed fetch/XHR, so grepping src/ for it finds nothing. Keep the
 * distinction in mind when editing: the relayTransport strings break if
 * that file is reworded, the RN one breaks if React Native rewords it.
 *
 * That these exist at all is worth reading twice. They are only necessary
 * because uncaught channel errors DO reach Sentry through the global
 * handler, which is the gap named under Known limitations in
 * .claude/rules/crash-reporting-scope.md.
 */
const EXPECTED_TRANSPORT_NOISE: RegExp[] = [
  /Network request failed/i,
  /Relay connection closed before it opened/i,
  /RelayTransport\.send\(\) called while not connected/i,
];

let initialized = false;

/**
 * Gates the crash-test affordance in Settings and the SDK's `debug` logging.
 * `EXPO_PUBLIC_KANGENTIC_CRASHTEST` is inlined at bundle time by the same
 * mechanism as every other `EXPO_PUBLIC_*` flag, so it can only be true in a
 * build that was dispatched with it on (`build-android.yml`'s `crash_test`
 * input) - never in a store build, never by default. It exists so this
 * app's own privacy claims can be verified against a delivered payload
 * instead of against `Sentry.init()` options, repeatably, after every SDK
 * upgrade. See the crash reporting section of docs/developer-guide.md.
 */
export function crashTestEnabled(): boolean {
  return process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST === '1';
}

/**
 * Throws from a timer rather than the caller's press handler, so it escapes
 * uncaught through the global handler - the same path a real crash takes -
 * instead of being swallowed by a React error boundary the handler sits
 * behind.
 */
export function throwTestError(): void {
  setTimeout(() => {
    throw new Error('crash-test: deliberate JS throw for crash-reporting verification');
  }, 0);
}

/** Exercises the native crash path, which JS-side `beforeSend` cannot filter. */
export function crashNatively(): void {
  Sentry.nativeCrash();
}

/**
 * Reports an error that a React error boundary CAUGHT.
 *
 * This exists because a boundary changes what gets reported, not just what
 * gets rendered: React hands a caught error to the boundary instead of to
 * `ErrorUtils`, so the global handler never sees it. Adding a boundary without
 * this call would trade a visible crash for an invisible one - strictly worse,
 * and it was written while iOS delivery was still unproven (it was proven on
 * the CI simulator on 2026-09-12). So every boundary reports through here.
 *
 * A no-op when `Sentry.init()` never ran, which is every build made from
 * source. The event still passes through `beforeSend`/`scrubEvent` like any
 * other JS-captured event, so the privacy controls in
 * `.claude/rules/crash-reporting-scope.md` apply unchanged.
 */
export function reportCaughtError(error: Error, boundary: string): void {
  if (!initialized) return;
  Sentry.captureException(error, { tags: { errorBoundary: boundary } });
}

/**
 * Where a handled failure was caught. A closed union rather than `string` so
 * the `site` tag is a compile-time literal: a caller cannot pass
 * `error.message` or anything computed, which is what makes the rule's "tags
 * are static literals" bullet mechanical instead of reviewed. Adding a member
 * means adding the literal here and asserting the call in that surface's
 * component test, on failure and not on success.
 */
export type HandledErrorSite =
  | 'board-archived-read'
  | 'composer-send'
  | 'connection-open'
  | 'crash-test'
  | 'create-task'
  | 'devices-paired-info';

/**
 * Error classes that are a normal condition on a phone, never a defect: no
 * channel, or a socket that dropped mid-request. Matched by NAME, not
 * `instanceof`: importing NotConnectedError from src/connection is an import
 * cycle (src/connection imports this module), and importing from src/channel
 * would pull the protocol stack into index.js's first import. Each entry is
 * the literal its constructor assigns to `this.name`.
 */
const HANDLED_ERROR_EXCLUDED_NAMES: ReadonlySet<string> = new Set(['NotConnectedError', 'ChannelDisconnectedError']);

/**
 * A retry loop must not burn the free tier: at most one report per site and
 * class per minute, and ten per launch. Server-side Spike Protection is the
 * backstop for a fleet-wide bug (docs/developer-guide.md). Counts read out
 * of Sentry for a handled site are therefore lower bounds.
 */
const HANDLED_REPORT_COOLDOWN_MS = 60_000;
const HANDLED_REPORTS_PER_KEY_PER_LAUNCH = 10;

/** An error name is an identifier, or it is not trusted as a tag value. */
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z_$][\w$]{0,63}$/;
const FRAME_LINE_PATTERN = /^\s+at\s/;

const handledReportLastAtMs = new Map<string, number>();
const handledReportCounts = new Map<string, number>();

interface HandledErrorShape {
  errorName: string;
  verb: CapabilityVerb | null;
  message: string;
  frames: string | null;
}

/**
 * The `    at ...` lines of a stack and nothing else. Hermes and V8 both
 * format `stack` as `${name}: ${message}` followed by one frame line per
 * frame, so the message is inside the string even though Sentry's parser
 * drops non-frame lines. Keeping only frame lines, and dropping any line the
 * message itself contains, makes "the message never enters the SDK" a
 * property of the string handed over rather than of the parser: a message
 * that carries a newline and a fake `at` line cannot become a frame either.
 */
function frameLinesOnly(stack: string | undefined, message: string): string | null {
  if (stack === undefined) return null;
  const messageLines = new Set(message.split('\n'));
  const frames = stack.split('\n').filter((line) => FRAME_LINE_PATTERN.test(line) && !messageLines.has(line));
  return frames.length === 0 ? null : frames.join('\n');
}

function describeHandledError(error: unknown): HandledErrorShape {
  if (!(error instanceof Error)) return { errorName: 'NonError', verb: null, message: '', frames: null };
  const errorName = SAFE_ERROR_NAME_PATTERN.test(error.name) ? error.name : 'Error';
  // Duck-typed rather than `instanceof CapabilityError`: importing src/channel
  // here would pull the protocol stack into index.js's first import, and the
  // verb is validated against the protocol's closed list either way.
  const verbCandidate: unknown = (error as Error & { verb?: unknown }).verb;
  const verb = typeof verbCandidate === 'string' && isCapabilityVerb(verbCandidate) ? verbCandidate : null;
  return { errorName, verb, message: error.message, frames: frameLinesOnly(error.stack, error.message) };
}

/**
 * Reports a failure the app CAUGHT and then showed the user, or turned into a
 * wrong-but-plausible state. The call-site policy (where to call this, and
 * where never to) lives in .claude/rules/crash-reporting-scope.md.
 *
 * What leaves the device is a synthetic Error - message `handled at <site>`,
 * the original's class name, the original's stack FRAMES - with the tags
 * `site`, `errorName`, and `verb` (only when the field is one of the
 * protocol's ten literals), fingerprinted on those three so grouping is by
 * site and kind, never by message. The original object, its message and its
 * `cause` chain never reach the SDK: a CapabilityError's peer-supplied text,
 * a Keychain error's detail, or a relay-transport string cannot ride out
 * through here. scrubEvent re-asserts that on any event tagged `site`, as a
 * second line of defence.
 *
 * `ignoreErrors` matches the message the SDK is given, which is the synthetic
 * one, so EXPECTED_TRANSPORT_NOISE is applied here against the ORIGINAL
 * message before it is discarded. A no-op when `Sentry.init()` never ran
 * (every build made from source), and it never throws into the path that was
 * already failing.
 */
export function reportHandledError(site: HandledErrorSite, error: unknown): void {
  if (!initialized) return;
  const described = describeHandledError(error);
  if (HANDLED_ERROR_EXCLUDED_NAMES.has(described.errorName)) return;
  if (EXPECTED_TRANSPORT_NOISE.some((pattern) => pattern.test(described.message))) return;

  const rateKey = `${site}|${described.errorName}|${described.verb ?? ''}`;
  const now = Date.now();
  const lastReportedAt = handledReportLastAtMs.get(rateKey);
  if (lastReportedAt !== undefined && now - lastReportedAt < HANDLED_REPORT_COOLDOWN_MS) return;
  const reportCount = handledReportCounts.get(rateKey) ?? 0;
  if (reportCount >= HANDLED_REPORTS_PER_KEY_PER_LAUNCH) return;
  handledReportLastAtMs.set(rateKey, now);
  handledReportCounts.set(rateKey, reportCount + 1);

  const reported = new Error(`handled at ${site}`);
  reported.name = described.errorName;
  // An own data property, so it shadows Hermes' Error.prototype.stack accessor
  // as well as V8's own-property form. Left as the synthetic's own stack (the
  // catch site) when the original had no frames, e.g. a thrown string.
  if (described.frames !== null) {
    Object.defineProperty(reported, 'stack', { value: described.frames, writable: true, configurable: true });
  }
  try {
    Sentry.captureException(reported, {
      tags: {
        site,
        errorName: described.errorName,
        ...(described.verb !== null ? { verb: described.verb } : {}),
      },
      fingerprint: ['handled', site, described.errorName, described.verb ?? ''],
    });
  } catch {
    // Reporting must never cascade into the path that was already failing.
  }
}

/**
 * The Settings crash-test row for the door. The canary's message is text
 * that must NOT arrive in Sentry: reading the delivered event back is the
 * only way to verify the redaction against a real payload, which is this
 * repo's standard for a privacy claim (see crashTestEnabled above). Shaped
 * like the peer-supplied case, a CapabilityError carrying a verb, so the
 * delivered tags prove the duck-typed verb path too.
 */
export function reportHandledTestError(): void {
  const canary = Object.assign(new Error('crash-test: THIS TEXT MUST NOT ARRIVE IN SENTRY'), {
    name: 'CapabilityError',
    verb: 'read-board',
  });
  reportHandledError('crash-test', canary);
}

/**
 * No DSN means no `Sentry.init()` at all, so the native SDK never starts
 * and nothing is collected or stored on device. That is the state for every
 * build a contributor or self-hoster makes from source: `EXPO_PUBLIC_SENTRY_DSN`
 * is injected at build time from the GitHub repository VARIABLE `SENTRY_DSN`
 * (a variable, not a secret, so it can be read back to confirm which project
 * a build reports to) and is never committed, so a fork reports nothing (and
 * cannot burn this project's free-tier quota).
 */
export function initializeCrashReporting(): void {
  if (initialized) return;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (dsn === undefined || dsn === '') return;
  initialized = true;

  Sentry.init({
    dsn,
    // Reaches native (not one of the options destructured out in
    // wrapper.js's initNativeSdk call), so a crash-test build gets verbose
    // sentry-android/sentry-cocoa logging of what it actually sends -
    // envelope contents included. Off in every other build.
    debug: crashTestEnabled(),
    // Four environment VALUES, not one per EAS profile: `development`,
    // `crash-test` and `e2e` would otherwise land in the same 5,000-event
    // budget as "production" and be indistinguishable from a real user's
    // crash. E2E matters as much as dev here: a Maestro APK is
    // release-shaped, so __DEV__ is FALSE in it, and a dispatched
    // `profile=e2e` build does receive the DSN (the workflow's HAS_SENTRY
    // gate is job-level and covers every matrix profile). Without this
    // branch every smoke-flow crash would be filed as a production incident.
    // `crash-test` sits ahead of `e2e` because a deliberate crash is the
    // dominant fact about a build, and it needs its own value for a sharper
    // reason than noise: a crash-test build reports the SAME release string
    // as the shipped build it was cut from (the iOS simulator probe and App
    // Store build 13 both read `0.6.3+13` from app.config.ts, and overriding
    // the release in JS would desynchronise it from the symbols the Xcode
    // phase uploads under the Info.plist value), so the environment is the
    // only thing that keeps a deliberate crash out of the production stream
    // the /sentry triage sweep filters on. `preview` sets none of the three
    // flags, so it deliberately falls through to `production` too - a fourth
    // EAS profile, not a fifth environment.
    environment: __DEV__
      ? 'development'
      : crashTestEnabled()
        ? 'crash-test'
        : process.env.EXPO_PUBLIC_KANGENTIC_E2E === '1'
          ? 'e2e'
          : 'production',

    // --- Privacy, set at the source because beforeSend cannot reach native events ---
    sendDefaultPii: false,
    // Screens render agent transcripts, terminal output and diff content.
    // A screenshot or view hierarchy attached to a crash would carry all of
    // it, in cleartext, off the device.
    attachScreenshot: false,
    attachViewHierarchy: false,
    // Would capture failed HTTP requests, including the relay URL.
    enableCaptureFailedRequests: false,
    // A session is a per-foreground ping. It powers crash-free rate, which
    // is genuinely useful, but it is usage telemetry and this app tells
    // users it collects none. Flip deliberately, with a privacy-policy
    // edit, not as a side effect (docs/privacy-policy.md).
    enableAutoSessionTracking: false,
    // Transaction names carry route parameters, which here are the
    // desktop's task IDs.
    enableAutoPerformanceTracing: false,
    enableUserInteractionTracing: false,
    // `tracesSampleRate` is deliberately ABSENT, not 0. The SDK decides
    // whether to register its tracing integrations with
    // `typeof options.tracesSampleRate === 'number'` (dist/js/integrations/
    // default.js), and 0 is a number, so setting it to 0 wires up
    // appStart, nativeFrames, stallTracking and timeToDisplay anyway and
    // then samples every span away. Omitting the key is what actually
    // means off, and the SDK's own source comment says so. Do not "fix"
    // this by adding an explicit 0 back.
    // Sentry's Logs product forwards console output as structured logs -
    // exactly the egress the console breadcrumb removal below prevents.
    enableLogs: false,

    // Session Replay is absent rather than disabled: no
    // `mobileReplayIntegration()` is registered and no replay sample rate
    // is set, so the SDK never loads it (it records screen content).
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((integration) => integration.name !== 'Breadcrumbs'),
      Sentry.breadcrumbsIntegration({
        // `console` defaults to TRUE. Every console.* call in the app would
        // otherwise become a breadcrumb and sync to the native scope.
        console: false,
        // RN's global fetch is built on XHR, so `xhr` alone is what records
        // request URLs; both are set so neither default can leak one back.
        xhr: false,
        fetch: false,
        // Web-only, no-ops in React Native. Set so the intent survives if
        // this app ever renders through react-native-web.
        dom: false,
        history: false,
        // Sentry's own "an event was sent" bookkeeping. Carries no app data
        // and is the one category allowlistBreadcrumb lets through.
        sentry: true,
      }),
    ],

    // --- Free-tier volume (5,000 errors/month, 30-day retention) ---
    // Not sampled down: at this app's volume every one of those events is
    // wanted. Volume is controlled by not generating noise (above) and by
    // Spike Protection plus a per-key rate limit configured server-side -
    // see the crash reporting section of docs/developer-guide.md.
    sampleRate: 1.0,
    ignoreErrors: EXPECTED_TRANSPORT_NOISE,
    maxBreadcrumbs: 20,

    beforeBreadcrumb: allowlistBreadcrumb,
    beforeSend: scrubEvent,
  });
}
