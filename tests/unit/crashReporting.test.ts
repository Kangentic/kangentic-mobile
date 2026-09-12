import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SentryReactNative from '@sentry/react-native';

/**
 * `src/observability/crashReporting.ts` is the single place every crash-reporting privacy
 * control lives, and those controls are the load-bearing evidence for the public claims in
 * docs/privacy-policy.md, docs/security.md, and the Play Data Safety / App Store privacy
 * declarations. A regression here (a flipped boolean, a filter literal that stops matching
 * after an SDK bump) ships silently: ESLint, tsc, and every other test stay green. This file
 * pins every option passed to `Sentry.init`, byte for byte, against that intent rather than
 * against whatever the source happens to compute.
 *
 * `@sentry/react-native` is mocked below (a string passed to `vi.mock`, not an import
 * declaration), so it does not trip the `no-restricted-imports` zone that confines the real SDK
 * to src/observability/. The only reference to the real package is the type-only import above,
 * which `allowTypeImports` exempts (see .claude/rules/crash-reporting-scope.md).
 */

const sentryState = vi.hoisted(() => {
  const freshBreadcrumbsIntegration = { name: 'Breadcrumbs' };
  return {
    init: vi.fn(),
    breadcrumbsIntegration: vi.fn(() => freshBreadcrumbsIntegration),
    nativeCrash: vi.fn(),
    captureException: vi.fn(),
    freshBreadcrumbsIntegration,
  };
});

vi.mock('@sentry/react-native', () => ({
  init: sentryState.init,
  breadcrumbsIntegration: sentryState.breadcrumbsIntegration,
  nativeCrash: sentryState.nativeCrash,
  captureException: sentryState.captureException,
}));

type ReactNativeInitOptions = Parameters<typeof SentryReactNative.init>[0];

const testDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';

/**
 * `initializeCrashReporting()` guards itself with a module-level `initialized` flag, so every
 * scenario below needs its own fresh module instance or the guard silently no-ops after the
 * first test. `vi.resetModules()` clears the registry; the next dynamic import re-evaluates
 * crashReporting.ts (and, transitively, scrubEvent.ts) from scratch.
 */
async function loadFreshCrashReporting(): Promise<typeof import('@/observability/crashReporting')> {
  vi.resetModules();
  return import('@/observability/crashReporting');
}

/**
 * The beforeBreadcrumb/beforeSend identity check needs to compare against the SAME module
 * instance of scrubEvent.ts that crashReporting.ts itself resolved, not against a copy loaded
 * before the registry was last reset. Importing both from the same post-reset generation,
 * regardless of which specifier resolves first, guarantees they share one cached instance keyed
 * by resolved file path.
 */
async function loadFreshCrashReportingWithScrubEvent(): Promise<{
  crashReporting: typeof import('@/observability/crashReporting');
  scrubEvent: typeof import('@/observability/scrubEvent');
}> {
  vi.resetModules();
  const [crashReporting, scrubEvent] = await Promise.all([
    import('@/observability/crashReporting'),
    import('@/observability/scrubEvent'),
  ]);
  return { crashReporting, scrubEvent };
}

function setSentryDsn(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = value;
}

function setE2eFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  else process.env.EXPO_PUBLIC_KANGENTIC_E2E = value;
}

function setCrashTestFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;
  else process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST = value;
}

function requireCapturedInitOptions(): ReactNativeInitOptions {
  const firstCall = sentryState.init.mock.calls[0];
  if (firstCall === undefined) {
    throw new Error('Sentry.init was not called');
  }
  return firstCall[0] as ReactNativeInitOptions;
}

describe('initializeCrashReporting', () => {
  const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const originalE2eFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  beforeEach(() => {
    sentryState.init.mockClear();
    sentryState.breadcrumbsIntegration.mockClear();
    sentryState.nativeCrash.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSentryDsn(originalDsn);
    setE2eFlag(originalE2eFlag);
    setCrashTestFlag(originalCrashTestFlag);
  });

  it('sets every privacy-critical option, so no screenshot, view hierarchy, PII, or telemetry leaves the device', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.dsn).toBe(testDsn);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.attachScreenshot).toBe(false);
    expect(options.attachViewHierarchy).toBe(false);
    expect(options.enableCaptureFailedRequests).toBe(false);
    expect(options.enableAutoSessionTracking).toBe(false);
    expect(options.enableAutoPerformanceTracing).toBe(false);
    expect(options.enableUserInteractionTracing).toBe(false);
    expect(options.enableLogs).toBe(false);
    // Absent, NOT 0. The SDK gates its tracing integrations on
    // `typeof tracesSampleRate === 'number'`, so an explicit 0 registers them
    // and merely samples every span away. `in` rather than a value check,
    // because `toBeUndefined()` would pass for an explicitly-set undefined too.
    expect('tracesSampleRate' in options).toBe(false);
  });

  it('drops the default Breadcrumbs integration and replaces it with a hardened, allowlisted one', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    const integrationsFactory = options.integrations;
    if (typeof integrationsFactory !== 'function') {
      throw new Error('expected the integrations option to be a factory function');
    }

    const defaultDedupeEntry = { name: 'Dedupe' };
    const defaultBreadcrumbsEntry = { name: 'Breadcrumbs' };
    const defaultHttpContextEntry = { name: 'HttpContext' };
    const syntheticDefaultIntegrations = [defaultDedupeEntry, defaultBreadcrumbsEntry, defaultHttpContextEntry];

    const resultIntegrations = integrationsFactory(syntheticDefaultIntegrations);

    // The default's own Breadcrumbs instance must not survive the filter.
    expect(resultIntegrations).not.toContain(defaultBreadcrumbsEntry);
    // Unrelated defaults pass through untouched.
    expect(resultIntegrations).toContain(defaultDedupeEntry);
    expect(resultIntegrations).toContain(defaultHttpContextEntry);
    // Exactly one Breadcrumbs integration survives, and it is the hardened replacement.
    expect(resultIntegrations.filter((integration) => integration.name === 'Breadcrumbs')).toHaveLength(1);
    expect(resultIntegrations).toContain(sentryState.freshBreadcrumbsIntegration);

    expect(sentryState.breadcrumbsIntegration).toHaveBeenCalledWith({
      console: false,
      xhr: false,
      fetch: false,
      dom: false,
      history: false,
      sentry: true,
    });
  });

  it('ignores exactly the three known transport-noise patterns, and caps breadcrumbs at 20', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.maxBreadcrumbs).toBe(20);

    const ignoreErrors = options.ignoreErrors;
    if (ignoreErrors === undefined) {
      throw new Error('ignoreErrors was not set');
    }
    expect(ignoreErrors).toHaveLength(3);
    const patternShapes = ignoreErrors.map((pattern) => {
      if (!(pattern instanceof RegExp)) {
        throw new Error('expected every ignoreErrors entry to be a RegExp');
      }
      return { source: pattern.source, flags: pattern.flags };
    });
    expect(patternShapes).toEqual([
      { source: 'Network request failed', flags: 'i' },
      { source: 'Relay connection closed before it opened', flags: 'i' },
      { source: 'RelayTransport\\.send\\(\\) called while not connected', flags: 'i' },
    ]);
  });

  it('wires beforeBreadcrumb and beforeSend to the real allowlistBreadcrumb and scrubEvent functions', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const { crashReporting, scrubEvent } = await loadFreshCrashReportingWithScrubEvent();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.beforeBreadcrumb).toBe(scrubEvent.allowlistBreadcrumb);
    expect(options.beforeSend).toBe(scrubEvent.scrubEvent);
  });

  it('resolves environment to e2e when the e2e flag is "1" and __DEV__ is false', async () => {
    setSentryDsn(testDsn);
    setE2eFlag('1');
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('e2e');
  });

  it('resolves environment to production when __DEV__ is false and the e2e flag is unset', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('production');
  });

  // Bonus coverage beyond the two branches asked for: this repo's vitest tier does not define
  // __DEV__ by default (confirmed against tests/unit/connectionManager.test.ts and
  // tests/unit/qr.test.ts, which both stub it explicitly before reaching code that reads it),
  // so all four branches are honestly reachable by stubbing the global ourselves the same way.
  it('resolves environment to development when __DEV__ is true, regardless of the e2e flag', async () => {
    setSentryDsn(testDsn);
    setE2eFlag('1');
    vi.stubGlobal('__DEV__', true);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('development');
  });

  it('resolves environment to crash-test when the crash-test flag is "1", ahead of e2e', async () => {
    // A crash-test build reports the SAME release string as the shipped build
    // it was cut from (build-ios.yml's simulator probe and App Store build 13
    // both read `0.6.3+13` from app.config.ts), so the environment is the only
    // thing that keeps a deliberate crash out of the production stream the
    // /sentry triage sweep filters on. Ahead of e2e because a deliberate crash
    // is the dominant fact about the build, whatever else it carries.
    setSentryDsn(testDsn);
    setE2eFlag('1');
    setCrashTestFlag('1');
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('crash-test');
  });

  it('still resolves environment to development under __DEV__ even with the crash-test flag', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    setCrashTestFlag('1');
    vi.stubGlobal('__DEV__', true);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('development');
  });

  it('passes debug: true to Sentry.init only when the crash-test flag is "1"', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    setCrashTestFlag('1');
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().debug).toBe(true);
  });

  it('passes debug: false to Sentry.init when the crash-test flag is unset', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    setCrashTestFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().debug).toBe(false);
  });

  it('never calls Sentry.init when EXPO_PUBLIC_SENTRY_DSN is unset', async () => {
    setSentryDsn(undefined);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).not.toHaveBeenCalled();
  });

  it('never calls Sentry.init when EXPO_PUBLIC_SENTRY_DSN is the empty string', async () => {
    setSentryDsn('');
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).not.toHaveBeenCalled();
  });

  it('calls Sentry.init exactly once even when initializeCrashReporting is called twice', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).toHaveBeenCalledTimes(1);
  });
});

describe('crashTestEnabled', () => {
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  afterEach(() => {
    setCrashTestFlag(originalCrashTestFlag);
  });

  it('is true only when the flag is exactly "1"', async () => {
    setCrashTestFlag('1');
    const crashReporting = await loadFreshCrashReporting();
    expect(crashReporting.crashTestEnabled()).toBe(true);
  });

  it('is false when the flag is unset', async () => {
    setCrashTestFlag(undefined);
    const crashReporting = await loadFreshCrashReporting();
    expect(crashReporting.crashTestEnabled()).toBe(false);
  });

  it('is false for a truthy-looking but non-"1" value, since EXPO_PUBLIC_* flags are strings', async () => {
    setCrashTestFlag('true');
    const crashReporting = await loadFreshCrashReporting();
    expect(crashReporting.crashTestEnabled()).toBe(false);
  });
});

describe('reportCaughtError', () => {
  const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const originalE2eFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  beforeEach(() => {
    sentryState.captureException.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSentryDsn(originalDsn);
    setE2eFlag(originalE2eFlag);
    setCrashTestFlag(originalCrashTestFlag);
  });

  it('does not call Sentry.captureException when the module never initialised (no DSN, every build made from source)', async () => {
    setSentryDsn(undefined);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    // Deliberately never called initializeCrashReporting(): this is the state
    // of a boundary catching a render error before init ran, and of every
    // fork or self-hosted build that never gets a DSN at all.
    crashReporting.reportCaughtError(new Error('boundary threw'), 'root-layout');

    expect(sentryState.captureException).not.toHaveBeenCalled();
  });

  it('calls Sentry.captureException with the caught error and the boundary tag once initialised', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    setCrashTestFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();
    const caughtError = new Error('boundary threw');
    crashReporting.reportCaughtError(caughtError, 'root-layout');

    expect(sentryState.captureException).toHaveBeenCalledTimes(1);
    expect(sentryState.captureException).toHaveBeenCalledWith(caughtError, {
      tags: { errorBoundary: 'root-layout' },
    });
  });
});

/**
 * The handled-error door. Every assertion here is a privacy claim as much as a
 * behaviour: the caught error may be a CapabilityError whose message is the
 * desktop's verbatim text, a Keychain error, or a relay-transport string, and
 * the door's contract is that NONE of that leaves the device - only the site,
 * the class name, a protocol verb, and the stack frames.
 */
describe('reportHandledError', () => {
  const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const originalE2eFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  beforeEach(() => {
    sentryState.captureException.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setSentryDsn(originalDsn);
    setE2eFlag(originalE2eFlag);
    setCrashTestFlag(originalCrashTestFlag);
  });

  /** A fresh module instance with Sentry.init already run, so the door is live. */
  async function loadInitialisedCrashReporting(): Promise<typeof import('@/observability/crashReporting')> {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    setCrashTestFlag(undefined);
    vi.stubGlobal('__DEV__', false);
    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();
    return crashReporting;
  }

  interface CapturedCall {
    error: Error;
    context: { tags?: Record<string, string>; fingerprint?: string[] };
  }

  function capturedCall(index = 0): CapturedCall {
    const call = sentryState.captureException.mock.calls[index];
    if (call === undefined) throw new Error(`Sentry.captureException call ${index} was not made`);
    return { error: call[0] as Error, context: (call[1] ?? {}) as CapturedCall['context'] };
  }

  /**
   * Everything the SDK was handed, flattened to text, so a test can assert a
   * secret string appears NOWHERE in the call - not in the message, not in
   * the stack, not in a tag, not in a `cause`. JSON.stringify alone drops an
   * Error's own properties, which is exactly where the text would hide.
   */
  function capturedCallText(index = 0): string {
    const call = sentryState.captureException.mock.calls[index];
    return JSON.stringify(call, (_key, value: unknown) => {
      if (value instanceof Error) {
        return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause };
      }
      return value;
    });
  }

  function capabilityErrorLike(message: string, verb: string): Error {
    return Object.assign(new Error(message), { name: 'CapabilityError', verb });
  }

  it('does not call Sentry.captureException when the module never initialised', async () => {
    setSentryDsn(undefined);
    vi.stubGlobal('__DEV__', false);
    const crashReporting = await loadFreshCrashReporting();

    crashReporting.reportHandledError('create-task', new Error('anything'));

    expect(sentryState.captureException).not.toHaveBeenCalled();
  });

  it('captures a synthetic error, never the original object or its message', async () => {
    const crashReporting = await loadInitialisedCrashReporting();
    const original = capabilityErrorLike('peer-supplied text from the desktop', 'board-tool-write');
    original.cause = new Error('a cause with more peer text');

    crashReporting.reportHandledError('create-task', original);

    expect(sentryState.captureException).toHaveBeenCalledTimes(1);
    const { error } = capturedCall();
    expect(error).not.toBe(original);
    expect(error.message).toBe('handled at create-task');
    expect(error.name).toBe('CapabilityError');
    expect(capturedCallText()).not.toContain('peer');
  });

  it('keeps only the stack frames of the original, not its header line', async () => {
    const crashReporting = await loadInitialisedCrashReporting();
    const original = capabilityErrorLike('secret', 'read-board');
    original.stack = 'CapabilityError: secret\n    at requireOk (a:1:2)\n    at foo (a:3:4)';

    crashReporting.reportHandledError('board-archived-read', original);

    expect(capturedCall().error.stack).toBe('    at requireOk (a:1:2)\n    at foo (a:3:4)');
    expect(capturedCallText()).not.toContain('secret');
  });

  it('drops a frame line smuggled inside the message', async () => {
    // Hermes formats `stack` as the header (`name: message`) followed by the
    // frames, so a message that itself contains a newline and a fake `at`
    // line would otherwise parse into a frame carrying arbitrary text.
    const crashReporting = await loadInitialisedCrashReporting();
    const original = new Error('x\n    at evil (http://x/y.js:1:1)');
    original.stack = 'Error: x\n    at evil (http://x/y.js:1:1)\n    at real (a:1:1)';

    crashReporting.reportHandledError('composer-send', original);

    expect(capturedCall().error.stack).toBe('    at real (a:1:1)');
    expect(capturedCallText()).not.toContain('evil');
  });

  it('tags the site, the error class name and a protocol verb', async () => {
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('create-task', capabilityErrorLike('peer text', 'board-tool-write'));

    expect(capturedCall().context.tags).toEqual({
      site: 'create-task',
      errorName: 'CapabilityError',
      verb: 'board-tool-write',
    });
  });

  it('omits the verb tag when the field is not one of the protocol verbs', async () => {
    // The verb is a closed union in @kangentic/protocol, so it is safe to tag;
    // an arbitrary string on a `verb` field is not, and must not ride along.
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('create-task', capabilityErrorLike('peer text', 'rm -rf /'));

    expect(capturedCall().context.tags).toEqual({ site: 'create-task', errorName: 'CapabilityError' });
    expect(capturedCallText()).not.toContain('rm -rf');
  });

  it('fingerprints on the site, class name and verb, never on the message', async () => {
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('create-task', capabilityErrorLike('peer text one', 'board-tool-write'));
    crashReporting.reportHandledError('composer-send', new Error('some other text'));

    expect(capturedCall(0).context.fingerprint).toEqual(['handled', 'create-task', 'CapabilityError', 'board-tool-write']);
    expect(capturedCall(1).context.fingerprint).toEqual(['handled', 'composer-send', 'Error', '']);
  });

  it('excludes the normal-condition error classes by name', async () => {
    // A phone with no channel is not a defect. Matched by name rather than
    // instanceof because importing the classes would cycle through
    // src/connection, which imports this module.
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('composer-send', Object.assign(new Error('x'), { name: 'NotConnectedError' }));
    crashReporting.reportHandledError('composer-send', Object.assign(new Error('x'), { name: 'ChannelDisconnectedError' }));

    expect(sentryState.captureException).not.toHaveBeenCalled();
  });

  it('excludes the expected transport noise by the ORIGINAL message, since the synthetic one defeats ignoreErrors', async () => {
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('composer-send', new Error('Network request failed'));
    crashReporting.reportHandledError('composer-send', new Error('Relay connection closed before it opened'));
    crashReporting.reportHandledError('composer-send', new Error('RelayTransport.send() called while not connected'));

    expect(sentryState.captureException).not.toHaveBeenCalled();
  });

  it('rate-limits one report per site and class per minute, without blocking a different site', async () => {
    vi.useFakeTimers();
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('create-task', new Error('one'));
    crashReporting.reportHandledError('create-task', new Error('two'));
    expect(sentryState.captureException).toHaveBeenCalledTimes(1);

    crashReporting.reportHandledError('composer-send', new Error('three'));
    expect(sentryState.captureException).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    crashReporting.reportHandledError('create-task', new Error('four'));
    expect(sentryState.captureException).toHaveBeenCalledTimes(3);
  });

  it('caps a site and class at ten reports per launch, whatever the spacing', async () => {
    vi.useFakeTimers();
    const crashReporting = await loadInitialisedCrashReporting();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      crashReporting.reportHandledError('create-task', new Error(`attempt ${attempt}`));
      vi.advanceTimersByTime(61_000);
    }

    expect(sentryState.captureException).toHaveBeenCalledTimes(10);
  });

  it('never forwards a non-Error value', async () => {
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('composer-send', 'a thrown string carrying secrets');

    const { error, context } = capturedCall();
    expect(error.message).toBe('handled at composer-send');
    expect(error.name).toBe('NonError');
    expect(context.tags).toEqual({ site: 'composer-send', errorName: 'NonError' });
    expect(capturedCallText()).not.toContain('secrets');
  });

  it('falls back to a generic class name when the original name is not an identifier', async () => {
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledError('composer-send', Object.assign(new Error('x'), { name: 'evil name with spaces' }));

    expect(capturedCall().error.name).toBe('Error');
    expect(capturedCall().context.tags).toEqual({ site: 'composer-send', errorName: 'Error' });
    expect(capturedCallText()).not.toContain('evil');
  });

  it('never throws into the failing path, even when the SDK does', async () => {
    const crashReporting = await loadInitialisedCrashReporting();
    sentryState.captureException.mockImplementationOnce(() => {
      throw new Error('sdk exploded');
    });

    expect(() => crashReporting.reportHandledError('composer-send', new Error('x'))).not.toThrow();
  });

  it('reportHandledTestError reports the canary with its site, class and verb, and without its text', async () => {
    // The Settings crash-test row that proves the redaction against a
    // DELIVERED payload: the canary's message must not arrive in Sentry.
    const crashReporting = await loadInitialisedCrashReporting();

    crashReporting.reportHandledTestError();

    expect(sentryState.captureException).toHaveBeenCalledTimes(1);
    const { error, context } = capturedCall();
    expect(error.message).toBe('handled at crash-test');
    expect(error.name).toBe('CapabilityError');
    expect(context.tags).toEqual({ site: 'crash-test', errorName: 'CapabilityError', verb: 'read-board' });
    expect(capturedCallText()).not.toContain('MUST NOT ARRIVE');
  });
});

describe('crashNatively', () => {
  beforeEach(() => {
    sentryState.nativeCrash.mockClear();
  });

  it('calls Sentry.nativeCrash()', async () => {
    const crashReporting = await loadFreshCrashReporting();
    crashReporting.crashNatively();
    expect(sentryState.nativeCrash).toHaveBeenCalledTimes(1);
  });
});

describe('throwTestError', () => {
  it('throws asynchronously, past the caller, rather than synchronously from the press handler', async () => {
    vi.useFakeTimers();
    try {
      const crashReporting = await loadFreshCrashReporting();

      // The point of a timer-deferred throw is that calling it does NOT throw
      // synchronously - that is what lets it escape a React error boundary
      // sitting around the caller.
      expect(() => crashReporting.throwTestError()).not.toThrow();
      expect(() => vi.runAllTimers()).toThrow('crash-test');
    } finally {
      // In a finally, so a failing assertion above cannot leave timers faked
      // for whatever test is appended after this one.
      vi.useRealTimers();
    }
  });
});
