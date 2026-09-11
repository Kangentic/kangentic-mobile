import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Asset } from 'expo-asset';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { IconButton, MonoText, useTheme, type TerminalPalette, type Theme } from '@/components';
import {
  decodeTerminalMessage,
  encodeHostMessage,
  type HostToTerminalMessage,
} from '@/terminal/terminalBridge';
import { parseColsFromScrollback } from '@/terminal/liveTail';
import { buildModeRestoreSequence } from '@/terminal/modeRestore';
import { XTERM_BUILD_ID } from '@/terminal/xtermBuildId';
import type { InspectTerminalHandle, InspectTerminalWriteStats } from '@/devsupport/inspectState';
import { getBufferedData, getTerminalDimensions, hasBufferedFrame, subscribeChunks } from '@/state/terminalFeed';
import { useReadingViewStore } from '@/state/readingViewStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { refreshTerminalStream, writeTerminal } from '@/connection/actions';
import { DirectKeyInput, type DirectKeyInputHandle } from './DirectKeyInput';

export interface TerminalPaneProps {
  sessionId: string;
  /**
   * True only while the Terminal tab is the visible page. When false the
   * WebView stops repainting: live writes are skipped (the terminalFeed ring
   * keeps buffering independently), so a hidden terminal never composites the
   * stream off-screen. On becoming visible again the pane re-seeds from the
   * ring to catch up.
   */
  isActive: boolean;
  /**
   * Enables the WebView's clean feed (a headless second parser posting
   * readable lines into the readingViewStore) - the chat reading view for
   * sessions whose agent has no structured transcript. Off by default; a
   * flip re-inits the terminal with the flag.
   */
  cleanFeedEnabled?: boolean;
}

const DEFAULT_TERMINAL_FONT_SIZE_PX = 12;
/**
 * Pinch floor inside the WebView. Deliberately below the 11px RN text floor
 * (ui-conventions.md): this is pinch-zoomable terminal CONTENT the user
 * scales at will - the fit-to-screen first paint of a wide desktop grid needs
 * small glyphs, and a pinch enlarges any part of it instantly.
 */
const MIN_TERMINAL_FONT_SIZE_PX = 6;
// Ceiling above the auto-fit default (capped at MAX_AUTO_FIT_FONT_PX = 20 in
// scripts/xterm-page/state.js) so pinch-zoom has headroom and never clamp-jumps
// off the default.
const MAX_TERMINAL_FONT_SIZE_PX = 56;
// 32ms (~30fps) coalesces a token firehose into fewer, larger writes than 16ms
// did, halving repaint frequency at a latency the eye cannot see. Keystroke
// echo is unaffected - keys go phone->desktop directly, not through this batch.
const CHUNK_BATCH_INTERVAL_MS = 32;
// While the user just SENT input (a scroll burst, a typed key), the bytes
// coming back are its ECHO, and batching an echo is pure added lag on top of
// the ~210ms hosted-relay round trip (measured 2026-08-02 against an idle
// session). Inside this window chunks paint immediately; the firehose
// batching resumes the moment the user stops interacting.
const INPUT_ECHO_WINDOW_MS = 250;
const FONT_SIZE_POST_THROTTLE_MS = 50;
// How long the reset button waits for its stream refresh to produce a re-seed
// before falling back to a local refit (the offline path). A live channel
// round-trips a seed well inside this.
const REFIT_FALLBACK_DELAY_MS = 700;

// Metro asset reference; ESM import syntax cannot load an html asset.
const xtermHtmlModule = require('../../terminal/xterm.html') as number;

/**
 * Whether the dev inspect harness is live. Same gate the rest of the inspect
 * loop uses, so the WebView eval path below is unreachable in any build a user
 * could install.
 */
const inspectEnabled = __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1';

/** How long to wait for the WebView to answer an injected expression. */
const TERMINAL_EVAL_TIMEOUT_MS = 5000;

interface PendingTerminalEval {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Settle an injected expression's reply. Returns false for anything that is not
 * an eval result, so the normal bridge decoder still sees every real message.
 */
function settleTerminalEval(rawMessage: string, pending: Map<string, PendingTerminalEval>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'eval-result' || typeof record.id !== 'string') return false;
  const entry = pending.get(record.id);
  if (!entry) return true;
  pending.delete(record.id);
  clearTimeout(entry.timer);
  if (record.ok === true) entry.resolve(record.value);
  else entry.reject(new Error(typeof record.error === 'string' ? record.error : 'terminal eval failed'));
  return true;
}

function clampTerminalFontSize(fontSizePx: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE_PX, Math.max(MIN_TERMINAL_FONT_SIZE_PX, fontSizePx));
}

/**
 * Maps the design-system terminal palette + semantic colors onto the xterm
 * ITheme key names the WebView glue passes straight to the Terminal
 * constructor (see src/terminal/terminalBridge.ts for why this stays a plain
 * string record).
 */
export function buildXtermTheme(palette: TerminalPalette, colors: Theme['colors']): Record<string, string> {
  return {
    background: colors.terminalBackground,
    foreground: colors.textPrimary,
    cursor: colors.accent,
    black: palette.ansiBlack,
    red: palette.ansiRed,
    green: palette.ansiGreen,
    yellow: palette.ansiYellow,
    blue: palette.ansiBlue,
    magenta: palette.ansiMagenta,
    cyan: palette.ansiCyan,
    white: palette.ansiWhite,
    brightBlack: palette.ansiBrightBlack,
    brightRed: palette.ansiBrightRed,
    brightGreen: palette.ansiBrightGreen,
    brightYellow: palette.ansiBrightYellow,
    brightBlue: palette.ansiBrightBlue,
    brightMagenta: palette.ansiBrightMagenta,
    brightCyan: palette.ansiBrightCyan,
    brightWhite: palette.ansiBrightWhite,
  };
}

/**
 * The raw interactive terminal: a FAITHFUL MIRROR of the desktop terminal.
 * An xterm.js WebView fed by the terminalFeed ring renders the desktop's
 * EXACT grid 1:1, with the font sized so the grid's ROWS fill the phone's
 * height. A grid wider than the screen then overflows and pans horizontally
 * (the cursor stays in view); pinch-zoom reads the detail.
 *
 * It NEVER resizes the desktop PTY - a shared desktop session must not be
 * reshaped by the phone. Keyboard input typed inside the WebView flows back
 * out as 'input' and is written to the PTY (the one thing the phone sends);
 * pinch zoom adjusts the local font between MIN_TERMINAL_FONT_SIZE_PX and
 * MAX_TERMINAL_FONT_SIZE_PX (6 to 56).
 */
export function TerminalPane({ sessionId, isActive, cleanFeedEnabled = false }: TerminalPaneProps): React.JSX.Element {
  const theme = useTheme();
  const webViewRef = useRef<WebView>(null);
  const directKeyRef = useRef<DirectKeyInputHandle>(null);
  const [terminalHtmlUri, setTerminalHtmlUri] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // Bumped to remount the WebView after the OS kills its renderer (the
  // Android render process under memory pressure, the iOS content process).
  // Without a handler that surfaces as a native crash or a permanently blank
  // terminal; a remount reloads the page, whose 'ready' re-seeds from the ring.
  const [webViewGeneration, setWebViewGeneration] = useState(0);
  const recoverWebView = useCallback(() => {
    setTerminalReady(false);
    setWebViewGeneration((generation) => generation + 1);
  }, []);
  // Read inside the live-feed listener so pausing takes effect without
  // re-subscribing the feed on every tab switch.
  const isActiveRef = useRef(isActive);
  // Font size lives in refs, not state: nothing renders from it (the WebView
  // owns the glyphs), and a re-render per pinch frame would be pure waste.
  const fontSizePxRef = useRef(DEFAULT_TERMINAL_FONT_SIZE_PX);
  const pinchBaseFontSizeRef = useRef(DEFAULT_TERMINAL_FONT_SIZE_PX);
  const lastFontSizePostAtRef = useRef(0);
  const pendingChunksRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When this pane last SENT input (a scroll burst, a WebView-typed key);
  // incoming chunks inside INPUT_ECHO_WINDOW_MS of it skip the batch timer.
  const lastInputSentAtRef = useRef(0);
  const pendingEvalsRef = useRef(new Map<string, PendingTerminalEval>());
  const evalSequenceRef = useRef(0);
  // PTY write outcomes, for the inspect probe. Failures are deliberately
  // swallowed at the call site (the connection banner is the user-facing
  // surface for a dropped channel), which meant a write that silently stopped
  // reaching the desktop produced NO signal anywhere - the gesture looked
  // correct, the payload looked correct, and the terminal simply did not
  // move. Counting three numbers costs nothing and turns that into a reading.
  // Per PANE, not module-level: two mounted panes (a session screen stacked
  // under another) must not mix their counts under whichever sessionId
  // happens to be registered with the inspect bridge.
  const terminalWriteStatsRef = useRef<InspectTerminalWriteStats>({
    attempts: 0,
    failures: 0,
    lastError: null,
    lastAttemptAt: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const htmlAsset = Asset.fromModule(xtermHtmlModule);
    htmlAsset
      .downloadAsync()
      .then(() => {
        if (!cancelled) setTerminalHtmlUri(htmlAsset.localUri ?? htmlAsset.uri);
      })
      .catch(() => {
        // Local assets are bundled; fall back to the packager/bundle URI.
        if (!cancelled) setTerminalHtmlUri(htmlAsset.uri);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const postToTerminal = useCallback((message: HostToTerminalMessage) => {
    webViewRef.current?.postMessage(encodeHostMessage(message));
  }, []);

  /**
   * Run an expression inside the WebView and resolve its value.
   *
   * Everything that decides how the terminal behaves - measured grid height,
   * line height, buffer type, mouse encoding, what the last gesture computed -
   * lives in the page and is invisible from RN. This is the only way to read it
   * without a person holding the phone, which is what made the scroll work
   * guess-driven. Dev-gated at the registration site below.
   */
  const runTerminalEval = useCallback(
    (expression: string) =>
      new Promise<unknown>((resolve, reject) => {
        const webView = webViewRef.current;
        if (webView === null) {
          reject(new Error('terminal WebView is not mounted'));
          return;
        }
        evalSequenceRef.current += 1;
        const evalId = `eval-${evalSequenceRef.current}`;
        const pending = pendingEvalsRef.current;
        const timer = setTimeout(() => {
          pending.delete(evalId);
          reject(new Error('terminal eval timed out (is the page still loading?)'));
        }, TERMINAL_EVAL_TIMEOUT_MS);
        pending.set(evalId, { resolve, reject, timer });
        // The trailing `true;` is required by injectJavaScript on iOS: without a
        // primitive result the WKWebView bridge logs a warning per call.
        webView.injectJavaScript(
          `(function(){var evalId=${JSON.stringify(evalId)};` +
            `function reply(payload){window.ReactNativeWebView.postMessage(JSON.stringify(payload));}` +
            `try{var value=(${expression});` +
            `reply({type:'eval-result',id:evalId,ok:true,value:value===undefined?null:value});}` +
            `catch(evalError){reply({type:'eval-result',id:evalId,ok:false,` +
            `error:String(evalError&&evalError.message?evalError.message:evalError)});}})();true;`,
        );
      }),
    [],
  );

  // Publish this pane to the inspect bridge while it is mounted. Unmounting
  // clears it, so "no terminal pane mounted" is an honest answer rather than a
  // stale handle answering for a screen nobody is looking at.
  useEffect(() => {
    if (!inspectEnabled) return;
    let released = false;
    let registeredHandle: InspectTerminalHandle | null = null;
    void import('@/devsupport/inspectState').then((inspectStateModule) => {
      if (released) return;
      registeredHandle = {
        sessionId,
        expectedBuildId: XTERM_BUILD_ID,
        evaluate: runTerminalEval,
        writeStats: () => ({ ...terminalWriteStatsRef.current }),
      };
      inspectStateModule.setInspectTerminal(registeredHandle);
    });
    const pending = pendingEvalsRef.current;
    return () => {
      released = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('terminal pane unmounted'));
      }
      pending.clear();
      void import('@/devsupport/inspectState').then((inspectStateModule) => {
        // Only clear our OWN registration. With two panes mounted (a session
        // screen stacked under another), the covered pane's unmount must not
        // null out the visible pane's still-valid handle - that read as "no
        // terminal pane mounted" while a terminal was on screen and working.
        if (registeredHandle !== null && inspectStateModule.getInspectTerminal() === registeredHandle) {
          inspectStateModule.setInspectTerminal(null);
        }
      });
    };
  }, [sessionId, runTerminalEval]);

  // When the last init was posted; the reset button reads it to decide whether
  // its stream refresh actually produced a re-seed.
  const lastInitPostAtRef = useRef(0);
  const refitFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refitFallbackTimerRef.current !== null) clearTimeout(refitFallbackTimerRef.current);
    };
  }, []);

  const postInit = useCallback(() => {
    lastInitPostAtRef.current = Date.now();
    const scrollback = getBufferedData(sessionId);
    const ptyDimensions = getTerminalDimensions(sessionId);
    // Put the terminal back into the modes the desktop's TUI set once at
    // startup BEFORE replaying the tail. The feed is a ring, so those DECSETs
    // are long evicted, and without this every re-init comes up in the normal
    // buffer with mouse reporting off while the PTY is in the alternate screen
    // with it on - which silently disables history scrolling. See
    // src/terminal/modeRestore.ts for the measurements.
    const modeRestore = buildModeRestoreSequence(
      useTerminalUiStore.getState().stickyModesBySessionId[sessionId] ?? null,
    );
    postToTerminal({
      type: 'init',
      scrollback: modeRestore + scrollback,
      // The desktop's exact grid. When the dims have not arrived yet (e.g.
      // mid-reconnect, before the snapshot lands) infer cols from content and
      // leave rows null; the real grid arrives shortly as a 'resize'.
      cols: ptyDimensions ? ptyDimensions.cols : parseColsFromScrollback(scrollback),
      rows: ptyDimensions ? ptyDimensions.rows : null,
      fontSizePx: fontSizePxRef.current,
      theme: buildXtermTheme(theme.terminalPalette, theme.colors),
      cleanFeed: cleanFeedEnabled,
    });
  }, [postToTerminal, sessionId, theme, cleanFeedEnabled]);

  const flushPendingChunks = useCallback(() => {
    const joinedData = pendingChunksRef.current.join('');
    pendingChunksRef.current = [];
    if (joinedData.length > 0) postToTerminal({ type: 'write', data: joinedData });
  }, [postToTerminal]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Live feed, attached only after the WebView said 'ready' (writes posted
  // before then would race the Terminal construction). Chunks batch on a
  // short timer so a fast token stream becomes one write per frame-ish.
  useEffect(() => {
    if (!terminalReady) return;
    const unsubscribe = subscribeChunks(sessionId, (event) => {
      // Paused (tab not visible): the ring keeps every byte; drop the render
      // work and re-seed from the ring when the tab becomes visible again.
      if (!isActiveRef.current) return;
      if (event.kind === 'dims') {
        // The desktop's authoritative grid (snapshot or a desktop refit).
        // Adopt it and re-fit the whole frame to screen - this is READ-ONLY;
        // the phone never sends a resize back.
        postToTerminal({ type: 'resize', cols: event.cols, rows: event.rows });
        return;
      }
      if (event.kind === 'seed') {
        // A fresh read-stream subscribe replaced the buffer: drop anything
        // queued and re-init the terminal from the new scrollback.
        pendingChunksRef.current = [];
        clearFlushTimer();
        postInit();
        return;
      }
      pendingChunksRef.current.push(event.data);
      // Echo fast path: see INPUT_ECHO_WINDOW_MS. The scroll repaint (or the
      // typed key's echo) paints the moment it arrives instead of waiting out
      // the firehose batch.
      if (Date.now() - lastInputSentAtRef.current < INPUT_ECHO_WINDOW_MS) {
        clearFlushTimer();
        flushPendingChunks();
        return;
      }
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushPendingChunks();
        }, CHUNK_BATCH_INTERVAL_MS);
      }
    });
    return () => {
      unsubscribe();
      clearFlushTimer();
      flushPendingChunks();
    };
  }, [terminalReady, sessionId, postInit, flushPendingChunks, clearFlushTimer, postToTerminal]);

  // Pause/resume rendering with tab visibility. When the terminal becomes the
  // visible page again, drop any queued writes and re-seed from the ring so the
  // WebView jumps straight to the latest frame it missed while paused.
  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (isActive && !wasActive && terminalReady) {
      pendingChunksRef.current = [];
      clearFlushTimer();
      postInit();
    }
  }, [isActive, terminalReady, postInit, clearFlushTimer]);

  // Coming back from the background can leave the mirror with holes: the
  // WebView survives (no 'ready', so nothing re-inits) but its renderer has
  // dropped glyphs, and single characters go missing mid-line and STAY
  // missing. Observed on a Pixel - "110 +" rendered as "10", "progress" as
  // "p ogress" - and repaired completely by the refit button, which is
  // exactly this message. So send it automatically: a refit re-fits the font
  // and re-applies the geometry, which forces a full repaint of the frame
  // already in the buffer. Purely local, no wire traffic.
  useEffect(() => {
    if (!terminalReady) return;
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active' || !isActiveRef.current) return;
      postToTerminal({ type: 'refit' });
    });
    return () => subscription.remove();
  }, [terminalReady, postToTerminal]);

  // Session swap under a mounted pane (the desktop respawned the task's
  // session): the WebView survives but its grid belongs to the dead session.
  // Drop anything queued and re-init from the NEW session's ring; the
  // successor's seed may already have landed while this pane was bound to the
  // old session, so waiting for a 'seed' event alone is not enough.
  //
  // But re-init ONLY when the successor has something to paint. A swap
  // normally arrives before its first snapshot does - SessionScreen retains
  // the new ring and asks the desktop for it, and the answer is a round trip
  // away - so an unconditional init here posts an EMPTY grid, which is the
  // black terminal this whole path is about. Holding the dead session's last
  // frame until the successor's seed arrives (which re-inits through the
  // subscribe callback's 'seed' branch above) is stale for a moment and
  // correct-looking throughout; SessionScreen's switching overlay is what
  // says so, and what times out if no successor ever arrives.
  //
  // The two halves of the key are tracked separately because a clean-feed
  // flip MUST post even with an empty ring: the flag only takes effect at
  // init, so skipping it would leave the WebView's parser in the wrong mode.
  const previousSessionIdRef = useRef(sessionId);
  const previousCleanFeedRef = useRef(cleanFeedEnabled);
  useEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    const cleanFeedChanged = previousCleanFeedRef.current !== cleanFeedEnabled;
    if (!sessionChanged && !cleanFeedChanged) return;
    previousSessionIdRef.current = sessionId;
    previousCleanFeedRef.current = cleanFeedEnabled;
    if (!terminalReady) return;
    if (sessionChanged && !cleanFeedChanged && !hasBufferedFrame(sessionId)) return;
    pendingChunksRef.current = [];
    clearFlushTimer();
    postInit();
  }, [sessionId, cleanFeedEnabled, terminalReady, postInit, clearFlushTimer]);

  // Drop this session's DECCKM + reading-view state on unmount. There is
  // nothing to release - the mirror never resized the PTY.
  useEffect(() => {
    return () => {
      useTerminalUiStore.getState().clearSession(sessionId);
      useReadingViewStore.getState().clearSession(sessionId);
    };
  }, [sessionId]);

  // The prompt cards' "Answer in terminal" escape hatch: consume the
  // one-shot keyboard-focus request only once this pane is actually the
  // visible page AND the WebView has finished construction - firing it
  // earlier would focus a hidden or not-yet-ready input. Not tied to a
  // manual lens toggle (SessionScreen's onModeChange never sets this flag),
  // so switching to Terminal by hand never pops the keyboard.
  const focusKeyboardRequested = useTerminalUiStore(
    (state) => state.focusKeyboardRequestBySessionId[sessionId] ?? false,
  );
  useEffect(() => {
    if (!focusKeyboardRequested || !isActive || !terminalReady) return;
    directKeyRef.current?.focus();
    useTerminalUiStore.getState().consumeFocusKeyboardRequest(sessionId);
  }, [focusKeyboardRequested, isActive, terminalReady, sessionId]);

  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // Eval replies are dev-harness traffic, not part of the terminal bridge
      // protocol; consume them before the decoder so it never sees them.
      if (inspectEnabled && settleTerminalEval(event.nativeEvent.data, pendingEvalsRef.current)) return;
      const message = decodeTerminalMessage(event.nativeEvent.data);
      if (message === null) return;
      if (message.type === 'ready') {
        postInit();
        setTerminalReady(true);
        return;
      }
      if (message.type === 'modes') {
        const terminalUi = useTerminalUiStore.getState();
        terminalUi.setApplicationCursorMode(sessionId, message.applicationCursorKeys);
        // Remembered so the NEXT init can replay them. The WebView's parser is
        // the only place these are known, and a terminal rebuilt from a ring
        // that has evicted the TUI's startup DECSETs cannot rediscover them.
        //
        // An INITIAL report is skipped once something is already stored: it
        // only describes what the seed established, so letting it write would
        // let a seed that lacked the DECSETs overwrite the very modes being
        // held to restore them - and since every later init would report the
        // same degraded baseline, the terminal could never climb back out.
        // Observed exactly that way while testing this fix.
        const alreadyStored = terminalUi.stickyModesBySessionId[sessionId] !== undefined;
        if (!message.initial || !alreadyStored) {
          terminalUi.setStickyModes(sessionId, {
            applicationCursorKeys: message.applicationCursorKeys,
            mouseTrackingMode: message.mouseTrackingMode,
            mouseEncoding: message.mouseEncoding,
            alternateBuffer: message.alternateBuffer,
          });
        }
        return;
      }
      if (message.type === 'font-size') {
        // The glue fit the font to the screen; keep the pinch baseline in sync
        // so the first pinch does not jump.
        const syncedFontSize = clampTerminalFontSize(Math.round(message.fontSizePx));
        fontSizePxRef.current = syncedFontSize;
        pinchBaseFontSizeRef.current = syncedFontSize;
        return;
      }
      if (message.type === 'renderer') {
        // Observability, mirroring the desktop's renderer report: WebGL is the
        // fast path; a 'dom' report means WebGL was unavailable or its context
        // was lost. Logged for now; a future devtools surface can read it.
        console.log(`[terminal] renderer for ${sessionId}: ${message.renderer}`);
        return;
      }
      if (message.type === 'clean-lines') {
        useReadingViewStore.getState().applyCleanLines(sessionId, message.lines, message.reset);
        return;
      }
      if (message.type === 'tapped') {
        // A clean tap (never a drag or pinch - the WebView's own gesture
        // code decides) toggles the soft keyboard for direct typing.
        directKeyRef.current?.toggle();
        return;
      }
      // 'input': keys typed inside the xterm WebView go to the desktop PTY.
      // Failures (not connected, capability revoked) are dropped silently -
      // the connection banner is the surface for that state - but they are
      // COUNTED, because a silent write failure is otherwise indistinguishable
      // from a gesture that never fired.
      terminalWriteStatsRef.current.attempts += 1;
      terminalWriteStatsRef.current.lastAttemptAt = Date.now();
      lastInputSentAtRef.current = Date.now();
      void writeTerminal(sessionId, message.data).catch((writeError: unknown) => {
        terminalWriteStatsRef.current.failures += 1;
        terminalWriteStatsRef.current.lastError =
          writeError instanceof Error ? writeError.message : String(writeError);
      });
    },
    [postInit, sessionId],
  );

  /* eslint-disable react-hooks/refs, react-hooks/purity -- the pinch callbacks run on touch
     events (runOnJS), never during render; the refs carry gesture-lifetime state and Date.now()
     throttles those event posts. The lint cannot see that .onUpdate/.onEnd are event handlers. */
  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    // The WebView cannot tell reliably that a pinch is happening: once this
    // gesture claims the touches, the page can stop receiving touchend for a
    // finger and counts it as still down forever, so its own touch list shows a
    // phantom second finger and every later one-finger drag reads as
    // multi-touch. Measured live at 15 touchstarts against 13 touchends, with
    // history scrolling dead until the terminal was rebuilt. This layer owns the
    // gesture, so it is the one that can say.
    //
    // Two FINGERS, never the gesture lifecycle: RNGH's PinchGestureHandler
    // begins on the FIRST touch of any kind (PinchGestureHandler.kt calls
    // begin() from STATE_UNDETERMINED, one finger included), so an onBegin
    // report marked every one-finger drag as a pinch and the page refused the
    // very drag the report was part of. Measured live: 524 touchmoves, 3
    // scrolls (the message-latency window), every other move exiting
    // 'pinch-active'. onStart backs this up at activation in case the second
    // finger lands mid-gesture in an order touches events miss.
    .onTouchesDown((touchesEvent) => {
      if (touchesEvent.numberOfTouches >= 2) postToTerminal({ type: 'pinch', active: true });
    })
    .onStart(() => {
      postToTerminal({ type: 'pinch', active: true });
    })
    // Fingers dropping below two END the pinch for scrolling purposes, even
    // though RNGH keeps the handler alive until the LAST finger lifts
    // (PinchGestureHandler.kt ends only on ACTION_UP, and deliberately ignores
    // onScaleEnd) - so waiting for onFinalize left the flag up through the
    // whole "pinch, keep one finger, drag" motion and blocked the drag.
    // Reproduced end to end on the emulator with raw multi-touch: the
    // human-timed replay dragged for 600ms after the lift and every move
    // exited 'pinch-active'. numberOfTouches here reports the count AFTER the
    // lifted finger is removed (trackedPointersCount decrements before the
    // touch event dispatches).
    .onTouchesUp((touchesEvent) => {
      if (touchesEvent.numberOfTouches <= 1) postToTerminal({ type: 'pinch', active: false });
    })
    .onTouchesCancelled((touchesEvent) => {
      if (touchesEvent.numberOfTouches <= 1) postToTerminal({ type: 'pinch', active: false });
    })
    .onFinalize(() => {
      postToTerminal({ type: 'pinch', active: false });
    })
    .onUpdate((pinchEvent) => {
      const nextFontSize = clampTerminalFontSize(Math.round(pinchBaseFontSizeRef.current * pinchEvent.scale));
      if (nextFontSize === fontSizePxRef.current) return;
      const now = Date.now();
      if (now - lastFontSizePostAtRef.current < FONT_SIZE_POST_THROTTLE_MS) return;
      lastFontSizePostAtRef.current = now;
      fontSizePxRef.current = nextFontSize;
      postToTerminal({ type: 'set-font-size', fontSizePx: nextFontSize });
    })
    .onEnd(() => {
      pinchBaseFontSizeRef.current = fontSizePxRef.current;
    });
  /* eslint-enable react-hooks/refs, react-hooks/purity */

  if (terminalHtmlUri === null) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.colors.terminalBackground }]}>
        <MonoText size="caption" color="muted">
          Terminal loading...
        </MonoText>
      </View>
    );
  }

  return (
    <GestureDetector gesture={pinchGesture}>
      <View style={[styles.flex, { backgroundColor: theme.colors.terminalBackground }]}>
        <WebView
          key={`terminal-webview-${webViewGeneration}`}
          ref={webViewRef}
          testID="terminal-webview"
          source={{ uri: terminalHtmlUri }}
          originWhitelist={['*']}
          allowFileAccess
          javaScriptEnabled
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          onMessage={onWebViewMessage}
          onRenderProcessGone={recoverWebView}
          onContentProcessDidTerminate={recoverWebView}
          style={[styles.flex, { backgroundColor: theme.colors.terminalBackground }]}
        />
        <DirectKeyInput ref={directKeyRef} sessionId={sessionId} />
        <View style={styles.scrollLatestButton}>
          <IconButton
            iconName="to-latest"
            variant="raised"
            testID="terminal-scroll-latest"
            accessibilityLabel="Jump to the latest terminal output"
            onPress={() => postToTerminal({ type: 'scroll-latest' })}
          />
        </View>
        <View style={styles.refitButton}>
          <IconButton
            iconName="contract"
            variant="raised"
            testID="terminal-refit"
            accessibilityLabel="Fit the terminal to the screen"
            onPress={() => {
              // A fresh frame from the desktop, then a local refit ONLY if the
              // re-seed never arrived. Posting both eagerly painted twice per
              // press (the refit's fit passes, then the seed's own re-init),
              // which read as screen flashes; the re-seed re-fits everything
              // itself, so the explicit refit is purely the offline fallback.
              const pressedAt = Date.now();
              refreshTerminalStream(sessionId);
              if (refitFallbackTimerRef.current !== null) clearTimeout(refitFallbackTimerRef.current);
              refitFallbackTimerRef.current = setTimeout(() => {
                refitFallbackTimerRef.current = null;
                if (lastInitPostAtRef.current < pressedAt) postToTerminal({ type: 'refit' });
              }, REFIT_FALLBACK_DELAY_MS);
            }}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  refitButton: {
    bottom: 12,
    position: 'absolute',
    right: 12,
  },
  scrollLatestButton: {
    bottom: 64,
    position: 'absolute',
    right: 12,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
