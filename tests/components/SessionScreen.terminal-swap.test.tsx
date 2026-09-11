import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionScreen } from '@/screens/task/SessionScreen';
import { decodeHostMessage } from '@/terminal/terminalBridge';
import { getTerminalFeedStats, hasBufferedFrame, resetTerminalFeed, retainTerminal, seedScrollback } from '@/state/terminalFeed';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

/**
 * The session-swap suite next door stubs TerminalTab, which is exactly why a
 * dead terminal feed was invisible to the component tier: every assertion it
 * makes about a swap is about the sessionId the screen hands down, and none
 * about whether anything still reaches the WebView.
 *
 * This suite mounts the REAL TerminalPane over the REAL @/connection/actions
 * (its openSessionScreen / closeSessionScreen are the retain and release
 * under test) with only the connection stubbed out, so the wire calls
 * short-circuit and just the store bookkeeping runs.
 */

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockParams: { taskId: string; sessionId?: string; projectId?: string } = {
  taskId: 'task-1',
  sessionId: 'sess-a',
  projectId: 'project-1',
};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

jest.mock('@/connection/connectionManager', () => ({
  getActiveConnection: () => null,
  requireVerbClient: () => {
    throw new Error('not connected (probe)');
  },
  requireSubscriptions: () => {
    throw new Error('not connected (probe)');
  },
  reconnectNow: jest.fn(),
}));

jest.mock('@/screens/task/ChatPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { __esModule: true, ChatPane: () => ReactModule.createElement(View, { testID: 'stub-chat-pane' }) };
});
jest.mock('@/screens/task/ChangesTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { __esModule: true, ChangesTab: () => ReactModule.createElement(View, { testID: 'stub-changes-tab' }) };
});
jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { __esModule: true, SessionInputBar: () => ReactModule.createElement(View, { testID: 'stub-input-bar' }) };
});

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      uri: 'file:///assets/xterm.html',
      localUri: 'file:///assets/xterm.html',
      downloadAsync: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('react-native-gesture-handler', () => {
  const mockChainablePinch = (): Record<string, unknown> => {
    const gestureStub: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_target, propertyName) => {
          if (typeof propertyName !== 'string' || propertyName === 'then') return undefined;
          return () => gestureStub;
        },
      },
    );
    return gestureStub;
  };
  return {
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: { Pinch: mockChainablePinch },
  };
});

jest.mock('react-native-webview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const mockReact = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const postMessageMock = jest.fn();
  const capturedProps: { current: Record<string, unknown> | null } = { current: null };
  const MockWebView = mockReact.forwardRef(function MockWebView(props: Record<string, unknown>, ref: unknown) {
    capturedProps.current = props;
    mockReact.useImperativeHandle(ref, () => ({ postMessage: postMessageMock }));
    return mockReact.createElement(View, { testID: props.testID });
  });
  return {
    __esModule: true,
    WebView: MockWebView,
    default: MockWebView,
    __postMessageMock: postMessageMock,
    __capturedProps: capturedProps,
  };
});

jest.mock('@/components/terminal/DirectKeyInput', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const mockReact = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const MockDirectKeyInput = mockReact.forwardRef(function MockDirectKeyInput(_props: unknown, ref: unknown) {
    mockReact.useImperativeHandle(ref, () => ({ toggle: jest.fn(), focus: jest.fn(), blur: jest.fn() }));
    return mockReact.createElement(View, { testID: 'terminal-direct-key-input' });
  });
  return { __esModule: true, DirectKeyInput: MockDirectKeyInput };
});

interface WebViewMockModule {
  __postMessageMock: jest.Mock;
  __capturedProps: { current: { onMessage?: (event: { nativeEvent: { data: string } }) => void } | null };
}
const webViewMock = jest.requireMock<WebViewMockModule>('react-native-webview');

function seedTaskWithSession(sessionId: string | null): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId }) },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function postFromWebView(data: string): void {
  act(() => {
    webViewMock.__capturedProps.current?.onMessage?.({ nativeEvent: { data } });
  });
}

function decodedPosts(): ReturnType<typeof decodeHostMessage>[] {
  return webViewMock.__postMessageMock.mock.calls.map((call) => decodeHostMessage(call[0] as string));
}

function postsCarrying(marker: string): ReturnType<typeof decodeHostMessage>[] {
  return decodedPosts().filter((message) => {
    if (message === null) return false;
    if (message.type === 'init') return message.scrollback.includes(marker);
    if (message.type === 'write') return message.data.includes(marker);
    return false;
  });
}

/**
 * Inits from `fromIndex` onwards whose scrollback carries no terminal
 * content. postInit prepends a mode-restore sequence built from the sticky
 * modes, so "blank" is "nothing but escape sequences", not a zero-length
 * string. Scoped to a starting index because the mount-time init is
 * legitimately blank - the ring holds nothing until the first snapshot.
 */
function blankInitPostsSince(fromIndex: number): ReturnType<typeof decodeHostMessage>[] {
  return decodedPosts()
    .slice(fromIndex)
    .filter(
      (message) =>
        message !== null &&
        message.type === 'init' &&
        message.scrollback.replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '') === '',
    );
}

describe('SessionScreen terminal pane across a session swap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTerminalFeed();
    webViewMock.__capturedProps.current = null;
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  it('keeps the mounted terminal pane fed when the board swaps the task session', async () => {
    seedTaskWithSession('sess-a');
    render(
      <ThemeProvider>
        <SessionScreen />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
    postFromWebView(JSON.stringify({ type: 'ready' }));

    // Mount path: the pane attached to the ORIGINAL session's ring.
    expect(getTerminalFeedStats()).toEqual([expect.objectContaining({ sessionId: 'sess-a', listeners: 1 })]);

    act(() => {
      seedScrollback('sess-a', 'ORIGINAL FRAME');
    });
    const postCountBeforeSwap = webViewMock.__postMessageMock.mock.calls.length;

    // The desktop respawned the task under a successor id: one board
    // snapshot, no intermediate null (the sessions projection + nav-param
    // fallback path, or a full-board race that skips the null snapshot).
    act(() => {
      seedTaskWithSession('sess-b');
    });

    const statsAfterSwap = getTerminalFeedStats();
    // The old ring is released, the successor's ring exists (openSessionScreen
    // retained it) - and the pane must be listening on it.
    expect(statsAfterSwap.map((stats) => stats.sessionId)).toEqual(['sess-b']);
    expect(statsAfterSwap[0]?.listeners).toBe(1);

    // Nothing may repaint the WebView between the swap and the successor's
    // seed. An init built from the empty successor ring wipes the last good
    // frame to an empty grid, which is the reported black terminal - and it
    // is invisible to the listener assertion above, because the seed's own
    // init lands either way.
    expect(blankInitPostsSince(postCountBeforeSwap)).toHaveLength(0);
    expect(webViewMock.__postMessageMock.mock.calls.length).toBe(postCountBeforeSwap);

    // The consequence, not just the bookkeeping: the successor's seed must
    // reach the WebView. Nothing else repaints the pane after a swap.
    act(() => {
      seedScrollback('sess-b', 'SUCCESSOR FRAME');
    });
    expect(postsCarrying('SUCCESSOR FRAME')).toHaveLength(1);
  });

  it('re-inits immediately when the successor ring is already seeded', async () => {
    seedTaskWithSession('sess-a');
    render(
      <ThemeProvider>
        <SessionScreen />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
    postFromWebView(JSON.stringify({ type: 'ready' }));

    // The successor's snapshot landed while the pane was still bound to the
    // dead session: its ring is retained and seeded BEFORE the screen sees
    // the new id. Waiting for a 'seed' event would hang forever here, so the
    // swap has to init from the ring it finds.
    act(() => {
      retainTerminal('sess-b');
      seedScrollback('sess-b', 'ALREADY HERE');
    });
    expect(postsCarrying('ALREADY HERE')).toHaveLength(0);

    act(() => {
      seedTaskWithSession('sess-b');
    });

    expect(postsCarrying('ALREADY HERE')).toHaveLength(1);
  });

  /**
   * The swap effect's gate (`if (sessionChanged && !cleanFeedChanged &&
   * !hasBufferedFrame(sessionId)) return;`) is deliberately split into two
   * independently-tracked halves: a SESSION swap holds an empty-ring re-init
   * back until the successor's seed arrives (the tests above), but a
   * CLEAN-FEED flip must always post, because the flag only takes effect at
   * init - skipping it would leave the WebView's parser stuck in the wrong
   * mode. Folding both into one shared `!hasBufferedFrame` gate (e.g.
   * `if ((sessionChanged || cleanFeedChanged) && !hasBufferedFrame(...))
   * return;`) would swallow this init exactly when the ring is empty, which is
   * the ordinary case for a session whose agent has no structured transcript.
   */
  it('re-inits on a clean-feed flip even with an empty ring, on the SAME session', async () => {
    seedTaskWithSession('sess-a');
    render(
      <ThemeProvider>
        <SessionScreen />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
    postFromWebView(JSON.stringify({ type: 'ready' }));

    // The precondition that makes this case distinct from the swap tests
    // above: nothing has ever seeded this session's ring.
    expect(hasBufferedFrame('sess-a')).toBe(false);

    const postCountBeforeFlip = webViewMock.__postMessageMock.mock.calls.length;

    // The window lands empty: selectChatLens flips to 'reading-view', which
    // is what SessionScreen forwards to TerminalTab as cleanFeedEnabled - no
    // session change at all.
    act(() => {
      useTranscriptStore.getState().retainSession('sess-a');
      useTranscriptStore.getState().applyWindow('sess-a', { revision: 1, totalEntries: 0, startIndex: 0, entries: [] });
    });

    const cleanFeedInitsSinceFlip = decodedPosts()
      .slice(postCountBeforeFlip)
      .filter((message) => message !== null && message.type === 'init' && message.cleanFeed === true);
    expect(cleanFeedInitsSinceFlip).toHaveLength(1);
  });
});
