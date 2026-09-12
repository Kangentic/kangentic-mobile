import { describe, expect, it } from 'vitest';
import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';
import { allowlistBreadcrumb, scrubEvent } from '@/observability/scrubEvent';

/**
 * These lock the payload shape that leaves the device. The privacy claims in
 * docs/privacy-policy.md and docs/security.md are only true if this holds.
 */

function errorEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    event_id: 'abc123',
    exception: { values: [{ type: 'TypeError', value: 'undefined is not a function' }] },
    ...overrides,
  };
}

describe('scrubEvent', () => {
  it('strips the user, so no per-device identity leaves with a crash', () => {
    const scrubbed = scrubEvent(errorEvent({ user: { id: 'device-42', ip_address: '10.0.0.7' } }));
    expect(scrubbed.user).toBeUndefined();
    expect('user' in scrubbed).toBe(false);
  });

  it('strips captured request data, which can carry the relay URL and headers', () => {
    const scrubbed = scrubEvent(
      errorEvent({ request: { url: 'wss://relay.kangentic.com/slot/deadbeef', headers: { cookie: 'x' } } }),
    );
    expect(scrubbed.request).toBeUndefined();
  });

  it('strips arbitrary extra data', () => {
    const scrubbed = scrubEvent(errorEvent({ extra: { transcript: 'the agent said something private' } }));
    expect(scrubbed.extra).toBeUndefined();
  });

  it('strips server_name, which on a phone is the device hostname', () => {
    const scrubbed = scrubEvent(errorEvent({ server_name: "dev's iPhone" }));
    expect(scrubbed.server_name).toBeUndefined();
  });

  it('drops contexts.response but keeps the diagnostic contexts around it', () => {
    const scrubbed = scrubEvent(
      errorEvent({
        contexts: {
          response: { status_code: 200, headers: { authorization: 'Bearer secret' } },
          device: { model: 'Pixel 8' },
          os: { name: 'Android', version: '15' },
        },
      }),
    );
    expect(scrubbed.contexts?.response).toBeUndefined();
    expect(scrubbed.contexts?.device).toEqual({ model: 'Pixel 8' });
    expect(scrubbed.contexts?.os).toEqual({ name: 'Android', version: '15' });
  });

  it('redacts every exception value on an event tagged with a handled-error site', () => {
    // The second line behind reportHandledError: the door already sends a
    // synthetic message, and this makes "no message text leaves through the
    // door" hold even if a future edit captures the original by mistake.
    // Every value, not just the first - the linked-errors integration appends
    // one entry per `cause`.
    const scrubbed = scrubEvent(
      errorEvent({
        tags: { site: 'create-task', errorName: 'CapabilityError' },
        exception: {
          values: [
            { type: 'CapabilityError', value: 'the desktop said something verbatim' },
            { type: 'Error', value: 'and its cause said more' },
          ],
        },
      }),
    );
    expect(scrubbed.exception?.values?.map((entry) => entry.value)).toEqual([
      'handled at create-task',
      'handled at create-task',
    ]);
    expect(scrubbed.exception?.values?.map((entry) => entry.type)).toEqual(['CapabilityError', 'Error']);
  });

  it('keeps the exception value on a boundary event, which is tagged errorBoundary rather than site', () => {
    // A render throw's message is app-authored and is what makes a boundary
    // event diagnosable; the redaction is keyed on `site` and nothing else.
    const scrubbed = scrubEvent(errorEvent({ tags: { errorBoundary: 'root-layout' } }));
    expect(scrubbed.exception?.values?.[0]?.value).toBe('undefined is not a function');
  });

  it('applies the breadcrumb allowlist to the event itself, where the native SDK merges its own breadcrumbs', () => {
    // beforeBreadcrumb sees only JS-recorded breadcrumbs. The SDK's
    // device-context integration then CONCATENATES the native scope's
    // breadcrumbs into every JS-captured event in a processEvent hook, which
    // runs before beforeSend - observed on the first iOS event the project
    // received (run 34672597979): `started` and `ui.lifecycle` rode a
    // JS-captured event past the allowlist. This is the second place the
    // allowlist has to be applied, and it is default-deny like the first.
    const scrubbed = scrubEvent(
      errorEvent({
        breadcrumbs: [
          { category: 'started', message: 'App started' },
          { category: 'ui.lifecycle', data: { state: 'UIApplicationDidBecomeActiveNotification' } },
          { category: 'sentry.event', message: 'An event was sent' },
          { message: 'no category at all' },
        ],
      }),
    );
    expect(scrubbed.breadcrumbs?.map((breadcrumb) => breadcrumb.category)).toEqual(['sentry.event']);
  });

  it('leaves breadcrumbs absent when nothing survives the allowlist, rather than sending an empty list', () => {
    const scrubbed = scrubEvent(errorEvent({ breadcrumbs: [{ category: 'ui.lifecycle' }, { category: 'started' }] }));
    expect('breadcrumbs' in scrubbed).toBe(false);
  });

  it('leaves contexts absent rather than inventing an empty object', () => {
    const scrubbed = scrubEvent(errorEvent());
    expect('contexts' in scrubbed).toBe(false);
  });

  it('omits contexts entirely when response was its only key', () => {
    // The same claim as the case above, reached by a different route: an
    // emptied container must not be sent as `contexts: {}`.
    const scrubbed = scrubEvent(
      errorEvent({ contexts: { response: { status_code: 500, headers: { authorization: 'Bearer secret' } } } }),
    );
    expect('contexts' in scrubbed).toBe(false);
  });

  it('preserves contexts untouched when there is no response context', () => {
    const scrubbed = scrubEvent(errorEvent({ contexts: { device: { model: 'Pixel 8' } } }));
    expect(scrubbed.contexts).toEqual({ device: { model: 'Pixel 8' } });
  });

  it('keeps the exception itself: the whole point is still to report the crash', () => {
    const scrubbed = scrubEvent(errorEvent({ user: { id: 'device-42' } }));
    expect(scrubbed.exception?.values?.[0]).toEqual({
      type: 'TypeError',
      value: 'undefined is not a function',
    });
    expect(scrubbed.event_id).toBe('abc123');
  });
});

describe('allowlistBreadcrumb', () => {
  function breadcrumb(category: string | undefined): Breadcrumb {
    return category === undefined ? { message: 'x' } : { category, message: 'x' };
  }

  it("lets Sentry's own event bookkeeping through", () => {
    expect(allowlistBreadcrumb(breadcrumb('sentry.event'))).not.toBeNull();
  });

  it('drops console breadcrumbs, the category that would carry app output', () => {
    expect(allowlistBreadcrumb(breadcrumb('console'))).toBeNull();
  });

  it('drops network breadcrumbs, which carry request URLs', () => {
    expect(allowlistBreadcrumb(breadcrumb('xhr'))).toBeNull();
    expect(allowlistBreadcrumb(breadcrumb('fetch'))).toBeNull();
  });

  it('drops navigation breadcrumbs, whose route params are desktop task IDs', () => {
    expect(allowlistBreadcrumb(breadcrumb('navigation'))).toBeNull();
  });

  it('is default-deny: an unanticipated category is dropped, not forwarded', () => {
    expect(allowlistBreadcrumb(breadcrumb('some.future.native.category'))).toBeNull();
    expect(allowlistBreadcrumb(breadcrumb('ui.click'))).toBeNull();
  });

  it('drops a breadcrumb with no category at all', () => {
    expect(allowlistBreadcrumb(breadcrumb(undefined))).toBeNull();
  });
});
