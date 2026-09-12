import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshControl,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { ReduceMotion, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, Screen, ConnectionBanner, EmptyState, Button, SectionHeader, useTheme } from '@/components';
import { TaskCard } from '@/components/board/TaskCard';
import {
  selectTriageRows,
  sectionForEntry,
  type SessionActivityEntry,
  type TriageSection,
  useActivityStore,
} from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import {
  peekAwaitedPrompt,
  peekLastAssistantMessage,
  peekLastTerminalLine,
  refreshSnapshots,
} from '@/connection/actions';
import { buildPendingPromptSummary, collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { MapperLoad } from '@/devsupport/MapperLoad';
import { AllQuietEmptyState } from './home/AllQuietEmptyState';
import { ConnectingEmptyState } from './home/ConnectingEmptyState';

/**
 * A session can briefly outlive its task's board entry (e.g. a snapshot
 * race on cold start), so a located-but-absent task falls back to this
 * minimal stand-in rather than crashing the shared TaskCard.
 */
function fallbackTask(entry: SessionActivityEntry): BoardTaskWire {
  return {
    id: entry.taskId,
    display_id: 0,
    title: 'Untitled task',
    description: '',
    swimlane_id: '',
    position: 0,
    agent: null,
    session_id: entry.sessionId,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    base_branch: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '',
    updated_at: '',
  };
}

type TriageListRow =
  | { kind: 'section-header'; section: TriageSection; title: string; count: number }
  | { kind: 'activity'; entry: SessionActivityEntry };

// Kangentic's Thinking/Idle is TURN-based, not presence-based (desktop
// vocabulary: the project tooltip counts "N thinking, N idle"). A session
// is Thinking while a turn is in flight; Idle once the turn ends OR a
// prompt waits on the user (desktop counts permission in the idle bucket:
// both mean it is the user's move). Idle therefore ranks ABOVE Thinking,
// and prompt cards render at the top of Idle under the shared header.
const SECTION_ORDER: TriageSection[] = ['needs-you', 'idle', 'working'];
const SECTION_TITLES: Record<TriageSection, string> = {
  'needs-you': 'Idle',
  idle: 'Idle',
  working: 'Thinking',
};

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const pairedState = useChannelStore((state) => state.pairedState);
  const [refreshing, setRefreshing] = useState(false);

  const collapsedTriageSection = useSettingsStore((state) => state.collapsedTriageSection);

  const rows = useMemo<TriageListRow[]>(() => {
    const sections = selectTriageRows({ bySessionId });
    // Total per TITLE first (needs-you + idle share the "Idle" title), so
    // the header shows the right count even when only one of the two
    // sections underneath it has entries.
    const countByTitle = new Map<string, number>();
    for (const sectionKind of SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      if (!section) continue;
      const title = SECTION_TITLES[sectionKind];
      countByTitle.set(title, (countByTitle.get(title) ?? 0) + section.entries.length);
    }
    const listRows: TriageListRow[] = [];
    const emittedTitles = new Set<string>();
    for (const sectionKind of SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      // Empty sections render nothing: the feed leads with what matters
      // instead of headers over blank space. needs-you + idle share the
      // Idle header (one title, prompt cards first).
      if (!section || section.entries.length === 0) continue;
      const title = SECTION_TITLES[section.section];
      if (!emittedTitles.has(title)) {
        emittedTitles.add(title);
        listRows.push({ kind: 'section-header', section: section.section, title, count: countByTitle.get(title) ?? 0 });
      }
      // The header row always renders (so it stays tappable to re-expand);
      // a collapsed title just skips the rows underneath it. No exception
      // for needs-you - a user may want to defer even a pending prompt
      // until they're back at their desk.
      if (collapsedTriageSection === title) continue;
      for (const entry of section.entries) listRows.push({ kind: 'activity', entry });
    }
    return listRows;
  }, [bySessionId, collapsedTriageSection]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  const established = useChannelStore((state) => state.established);
  // Gates "All quiet" on real data, not just channel-up: `established` flips
  // true before the first board snapshot lands (bootstrap runs after
  // establishment), so without this the empty feed briefly reads "All
  // quiet" on cold start before the desktop's actual sessions populate it.
  const hasHydratedSnapshot = useBoardStore((state) => state.hasHydratedSnapshot);
  /**
   * Reveal the feed once, assembled - not row by row as it arrives.
   *
   * The bootstrap declares EVERY project's board desired, and each board
   * answers in its own round-trip. `hasHydratedSnapshot` flips on the first
   * one, so the feed used to paint a fraction of its rows and then grow once
   * per remaining project, re-sorting and re-anchoring each time. Cold start
   * read as agents flickering in and the page lurching. Worse, if the first
   * board to answer had no live session the feed briefly claimed "All quiet"
   * while the rest were still in flight.
   *
   * `projects` is the declared set, so "every project has a board" is an
   * exact completion signal rather than a guessed delay. The deadline is only
   * a floor under a project that is slow or never answers.
   */
  const allBoardsAnswered = useBoardStore(
    (state) => state.projects.length > 0 && state.projects.every((project) => state.boardsByProjectId[project.id] !== undefined),
  );
  // Monotonic: the deadline only ever passes. Never reset on a disconnect -
  // a reconnect should resume the assembled feed, not blank it back to the
  // connecting state, and it also keeps a later project-list refresh (which
  // briefly makes allBoardsAnswered false again) from doing the same.
  const [revealDeadlinePassed, setRevealDeadlinePassed] = useState(false);
  useEffect(() => {
    if (!established || revealDeadlinePassed) return undefined;
    const timer = setTimeout(() => setRevealDeadlinePassed(true), FEED_REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [established, revealDeadlinePassed]);

  /**
   * Warm each session's snippet as soon as that session is known, rather than
   * when its row mounts.
   *
   * Waiting only on the boards revealed a complete, correctly ordered feed
   * whose description slots were all still EMPTY, and a beat later every one
   * of them filled in at once - the slots are fixed-height so nothing moved,
   * but the text still arrived as a second wave. Sessions register as each
   * board snapshot lands, so starting their peeks here overlaps them with the
   * remaining board round-trips and they are normally resolved by the time
   * the feed reveals; the row's own peek then hits the cache and paints in
   * its first frame.
   *
   * Deliberately does NOT gate the reveal. Whether you can see your agents at
   * all must not depend on a transcript-window fetch succeeding - a slow peek
   * should cost one row's snippet, not the whole feed.
   */
  const warmedSessionIdsRef = useRef(new Set<string>());
  // The effect below needs to run when the SET of sessions changes, so this
  // selector has to be set-valued. It must NOT be reduced to a count: a
  // snapshot that drops one session and adds another leaves the count
  // identical, and the new session would then never be warmed. Returning a
  // joined string rather than an array is also deliberate - a fresh array
  // identity every call would defeat Zustand's equality check and re-render
  // the feed on every activity event.
  const knownSessionIds = useActivityStore((state) => Object.keys(state.bySessionId).sort().join(','));
  useEffect(() => {
    if (!established) return;
    for (const entry of Object.values(useActivityStore.getState().bySessionId)) {
      if (warmedSessionIdsRef.current.has(entry.sessionId)) continue;
      // Already pushed by a 0.8.0+ desktop: warming it would re-fetch, over
      // the wire, the exact line we were just handed for free.
      if (entry.messagePreview !== null && sectionForEntry(entry) !== 'needs-you') continue;
      warmedSessionIdsRef.current.add(entry.sessionId);
      void peekSnippet(entry.sessionId, entry.awaitedPromptId, sectionForEntry(entry) === 'needs-you', 0).catch(() => {
        // The row retries on its own once mounted; a failed warm just means
        // that one snippet arrives late.
        warmedSessionIdsRef.current.delete(entry.sessionId);
      });
    }
  }, [knownSessionIds, established]);

  const feedReady = allBoardsAnswered || revealDeadlinePassed;

  // Long-press hub, the same form-sheet route the board uses. The row carries
  // its OWN projectId (rather than one screen-level id, as the board has)
  // because a triage feed spans every paired project at once.
  //
  // Stable identity: an inline arrow here would be a fresh prop on every
  // TriageHomeScreen render, which defeats ActivityRow's React.memo for
  // every visible card in the feed.
  const onLongPressTask = useCallback(
    (task: BoardTaskWire, projectId: string) => {
      router.push({ pathname: '/task-actions', params: { taskId: task.id, projectId } });
    },
    [router],
  );


  /**
   * The feed leads with what needs the user: Needs You, then Idle, then the
   * agents that are still working. Rows arrive incrementally as the snapshot
   * lands, and FlashList v2 enables maintainVisibleContentPosition by
   * default, so it holds whatever row it first anchored while higher-priority
   * rows insert ABOVE it - with 8+ agents the feed opened parked at the
   * bottom, showing the working sessions and hiding the ones waiting on you.
   * Pin to the top until the user scrolls, then leave them alone.
   */
  const listRef = useRef<FlashListRef<TriageListRow>>(null);
  /**
   * Whether the list is currently resting at the top, recomputed from the
   * scroll offset rather than latched the first time the user drags.
   *
   * A one-way latch would be safe only by accident: it happens to protect a
   * user who has scrolled, but it makes "at the top" a one-time event, and
   * anything that remounted the screen would re-arm it under someone who had
   * deliberately scrolled away. Reading the position instead makes the rule
   * exact and self-correcting - at the top, new rows keep you at the top;
   * scrolled away, nothing moves you; scroll back up and pinning resumes.
   *
   * It is the same contract the conversation feed gets from
   * maintainVisibleContentPosition's autoscrollToBottomThreshold, on the
   * opposite edge: pinned while you sit at the edge, released the moment you
   * leave it.
   */
  const restingAtTopRef = useRef(true);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    restingAtTopRef.current = event.nativeEvent.contentOffset.y <= TOP_ANCHOR_TOLERANCE_PX;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (!restingAtTopRef.current) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  if (pairedState === 'unpaired') {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <UnpairedEmptyState />
      </Screen>
    );
  }

  if (rows.length === 0 && established && hasHydratedSnapshot && feedReady) {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <ConnectionBanner />
        <AllQuietEmptyState />
      </Screen>
    );
  }

  // Paired with nothing to show while the channel comes up, or with the board
  // fan-out still landing: the Overseer holds the center (the banner still
  // escalates a long outage to Offline).
  if (rows.length === 0 || !feedReady) {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <ConnectionBanner />
        <ConnectingEmptyState />
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right']}>
      <AppHeader title="Agents" />
      <ConnectionBanner />
      <FlashList<TriageListRow>
        ref={listRef}
        testID="triage-home-list"
        data={rows}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSizeChange}
        refreshControl={
          // tintColor styles iOS; colors + progressBackgroundColor style
          // Android (stock is a white circle, jarring on the warm theme).
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.textSecondary}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surfaceOverlay}
          />
        }
        keyExtractor={(row) => (row.kind === 'section-header' ? `section-${row.section}` : row.entry.sessionId)}
        getItemType={(row) => (row.kind === 'section-header' ? 'section-header' : 'activity')}
        renderItem={({ item }) =>
          item.kind === 'section-header' ? (
            <SectionHeader
              title={item.title}
              // Keyed by the TITLE the user sees, not the underlying section.
              // "Idle" is shared by needs-you and idle, and which of the two
              // leads changes as a prompt arrives or resolves - so a
              // section-keyed id silently renames itself mid-session, which is
              // exactly the kind of moving selector an E2E flow cannot hold.
              // The collapse state is title-keyed for the same reason.
              testID={`section-header-${item.title.toLowerCase()}`}
              count={item.count}
              collapsed={collapsedTriageSection === item.title}
              onToggle={() => void useSettingsStore.getState().toggleTriageSectionCollapsed(item.title)}
            />
          ) : (
            <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              <ActivityRow entry={item.entry} onLongPressTask={onLongPressTask} />
            </View>
          )
        }
      />

    </Screen>
  );
}

function UnpairedEmptyState(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  return (
    <EmptyState
      testID="unpaired-empty-state"
      title="No desktop paired"
      caption="Connect your phone to Kangentic."
      overseerSize={90}
      overseerAnimate="blink-loop"
    >
      {/* Short label ("Pair") would hug tight; widen it into a substantial
          primary CTA - the hero action of this setup screen. */}
      <Button
        label="Pair"
        onPress={() => router.push('/pair')}
        testID="triage-pair-cta"
        style={{ paddingHorizontal: theme.spacing.xxl * 2 }}
      />
    </EmptyState>
  );
}

/** Lines the snippet slot always occupies, whatever it currently holds (see the row's fixed-geometry note). */
const SNIPPET_LINES = 2;

/**
 * How long the feed waits for every declared board before revealing itself
 * anyway. Only a floor under a project that is slow or never answers - the
 * normal path reveals as soon as the last board lands.
 */
const FEED_REVEAL_DEADLINE_MS = 2500;

/**
 * How far from offset 0 still counts as "resting at the top" for the feed's
 * anchor. Small on purpose: enough to absorb overscroll bounce and rounding,
 * not enough to grab someone who has deliberately scrolled down a little.
 */
const TOP_ANCHOR_TOLERANCE_PX = 8;


/** How long a row waits before retrying a failed snippet peek. */
const SNIPPET_PEEK_RETRY_MS = 6000;

/**
 * How long the snippet key must hold still before the row fetches it.
 *
 * The key carries unreadCount, which climbs once per engine event. A fresh
 * launch (and any catch-up burst) delivers those events back-to-back, so an
 * unsettled fetch painted a DIFFERENT older message per increment and the
 * row visibly flickered through the backlog. Waiting for the burst to stop
 * means one fetch, of the final state, and a row that fills in once.
 */
const SNIPPET_SETTLE_MS = 350;

/**
 * While a session is actively working its unread counter bumps on every
 * engine event; a snippet this old is still honest context, and the
 * throttle keeps a busy session from refetching a heavy transcript
 * window per event. Idle rows pass 0: the final message just landed and
 * must be fresh.
 */
const WORKING_SNIPPET_FRESHNESS_MS = 20_000;

/**
 * A row's snippet source, shared with the feed's pre-warm so both resolve
 * through the same caches: the pending decision when a prompt waits,
 * otherwise the agent's last message, falling back to the last readable
 * terminal line for transcript-less (codex-style) agents that still stream a
 * PTY. Throws when the message fetch failed AND left no fallback - the
 * caller treats that as retryable rather than as "no preview", since
 * successes cache and a stuck blank would never heal on its own.
 *
 * Takes primitives rather than the entry object so the row's effect can keep
 * depending on the few fields that should actually trigger a refetch.
 */
async function peekSnippet(
  sessionId: string,
  awaitedPromptId: string | null,
  isPermission: boolean,
  freshnessMs: number,
): Promise<string | null> {
  if (isPermission && awaitedPromptId !== null) {
    return buildPendingPromptSummary(await peekAwaitedPrompt(sessionId, awaitedPromptId));
  }
  let messagePeekFailed = false;
  const messageText = await peekLastAssistantMessage(sessionId, freshnessMs).catch(() => {
    messagePeekFailed = true;
    return null;
  });
  const snippetText = messageText ?? (await peekLastTerminalLine(sessionId, freshnessMs));
  if (snippetText === null && messagePeekFailed) throw new Error('snippet peek failed');
  return snippetText;
}

/**
 * The landing pulse: a row that just changed sections tints briefly at
 * its new position so the eye can track the move. Marked event-side only
 * (see activityStore.sectionChangedAt), so a reconnect snapshot that
 * reshuffles everything stays silent.
 */
const SECTION_PULSE_WINDOW_MS = 3000;
const SECTION_PULSE_MAX_OPACITY = 0.16;
const SECTION_PULSE_FADE_MS = 700;

const ActivityRow = React.memo(function ActivityRow({
  entry,
  onLongPressTask,
}: {
  entry: SessionActivityEntry;
  onLongPressTask: (task: BoardTaskWire, projectId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // The full task (not just title): the Agents feed renders the EXACT SAME
  // card as the board - labels, PR, usage bar - via the same shared
  // TaskCard, plus the project name sharing the title row (the
  // board's only structural addition). The ticket number is the one
  // deliberate exception: a triage feed cares about status/title/last
  // message, not the ticket ID, so it is always off here regardless of the
  // board's own showTicketNumbers setting (the board is the ticket-reference
  // view). That also keeps the fallback stand-in's placeholder display_id
  // off screen. A session can outlive its task's board entry briefly (e.g. a
  // snapshot race), so a located-but-absent task falls back to that minimal
  // stand-in rather than crashing.
  const locatedTask = useBoardStore((state) => state.boardsByProjectId[entry.projectId]?.tasksById[entry.taskId] ?? null);
  const task = locatedTask ?? fallbackTask(entry);
  const projectName = useBoardStore(
    (state) => state.projects.find((project) => project.id === entry.projectId)?.name ?? null,
  );

  const section = sectionForEntry(entry);
  const working = section === 'working';
  const isPermission = section === 'needs-you';

  const openTask = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]',
      // A prompt-pending row lands on the chat lens, where the answerable
      // prompt card lives; everything else opens the terminal default.
      params: isPermission
        ? { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId, mode: 'chat' }
        : { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId },
    });
  }, [router, entry.taskId, entry.sessionId, entry.projectId, isPermission]);

  const onLongPress = useCallback(() => {
    onLongPressTask(task, entry.projectId);
  }, [onLongPressTask, task, entry.projectId]);

  // Desktop-parity status treatment: green spinner while the agent works,
  // the yellow mail envelope for EVERY idle session (a pending prompt is
  // idle too - all idle rows are equal priority, first come first served).
  const statusKind = working ? 'working' : entry.unreadCount > 0 ? 'idle-unread' : 'idle';

  // One subtle tint fade when the row lands in a new section. The cleanup
  // zeroes the shared value: FlashList recycles row instances, and a
  // reused card must never inherit a mid-flight pulse.
  //
  // NOTE (idle-CPU lever, deferred): this registers one always-on
  // `useAnimatedStyle` mapper per row even when no pulse is playing, and the
  // per-vsync Reanimated flush walks every registered mapper (measured: ~0.47
  // CPU points each on a release build - see AgentStatusIcon). Gating it to
  // mount only while pulsing is a real saving but fights the strict
  // react-hooks purity / set-state-in-effect rules (a time-window mount needs a
  // clock, which is impure in render and cascades as setState in an effect), so
  // it is left as a documented follow-up rather than forced. The higher-leverage
  // reduction - AgentStatusIcon's two dead mappers per idle row - already landed.
  const sectionChangedAt = entry.sectionChangedAt;
  const pulseOpacity = useSharedValue(0);
  useEffect(() => {
    if (sectionChangedAt !== null && Date.now() - sectionChangedAt < SECTION_PULSE_WINDOW_MS) {
      pulseOpacity.value = SECTION_PULSE_MAX_OPACITY;
      pulseOpacity.value = withTiming(0, { duration: SECTION_PULSE_FADE_MS, reduceMotion: ReduceMotion.System });
    }
    return () => {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = 0;
    };
  }, [sectionChangedAt, pulseOpacity]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  // Inbox-style snippet, the row's body for EVERY state: the pending
  // decision when a prompt waits, otherwise the agent's last message
  // (context for thinking rows too). WHEN to refetch is decided entirely by
  // the effect's dependency array below (the prompt id, or unreadCount, which
  // bumps on every new message), so a re-render never refetches.
  const awaitedPromptId = entry.awaitedPromptId;
  const [peekedSnippet, setPeekedSnippet] = useState<{ text: string | null } | null>(null);
  const [peekRetryNonce, setPeekRetryNonce] = useState(0);
  // The last text resolved, shown until a newer one REPLACES it - never
  // cleared while a refetch is in flight. Blanking it on each refetch flashed
  // the row text -> empty -> text on every engine event.
  const snippet = peekedSnippet !== null ? peekedSnippet.text : null;
  // While working, a slightly stale snippet is fine (the throttle stops a
  // busy session from refetching a heavy window on every event); at idle
  // the final message must be fresh, and the freshness flip on the
  // working-to-idle transition refires the effect to fetch it.
  const snippetFreshnessMs = working ? WORKING_SNIPPET_FRESHNESS_MS : 0;
  // "Has this row ever resolved a peek" as a ref, not the state value: the
  // effect only needs it to choose immediate-vs-settled, and depending on the
  // snippet state would re-run the effect on every resolved peek.
  const hasResolvedPeekRef = useRef(false);
  /**
   * A desktop on protocol 0.8.0+ pushes the message preview on the activity
   * feed, so this row already has its line and must NOT fetch one - skipping
   * the peek here is where the per-session transcript requests actually go
   * away. A prompt-pending row still peeks: its body is the pending decision,
   * which the preview does not describe.
   */
  const previewPushedByDesktop = !isPermission && entry.messagePreview !== null;
  useEffect(() => {
    if (previewPushedByDesktop) return undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Let a burst settle before REFETCHING: each unreadCount bump re-runs
    // this effect and clears the previous timer, so a catch-up storm
    // resolves to one peek for the LAST key instead of one paint per event.
    // The FIRST peek has no burst to absorb and the card is waiting on it,
    // so it fires immediately - delaying it would only slow the cold start
    // the settle exists to smooth.
    const settleTimer = hasResolvedPeekRef.current ? setTimeout(runPeek, SNIPPET_SETTLE_MS) : (runPeek(), null);

    function runPeek(): void {
      if (cancelled) return;
      // The feed pre-warms these before it reveals itself, so on cold start
      // this call resolves straight from the peek caches and the row paints
      // its snippet in its first frame rather than a beat later.
      void peekSnippet(entry.sessionId, awaitedPromptId, isPermission, snippetFreshnessMs)
        .then((snippetText) => {
          if (cancelled) return;
          hasResolvedPeekRef.current = true;
          // Re-resolving the SAME text must not touch state: a new object
          // would re-render the row (and restart its animations) for a
          // snippet that did not actually change.
          setPeekedSnippet((previous) => (previous !== null && previous.text === snippetText ? previous : { text: snippetText }));
        })
        .catch(() => {
          // Not connected yet or a transient fetch failure: retry shortly.
          // The loop self-terminates on the first resolved peek (results
          // cache by key, so repeat runs after that are free).
          if (!cancelled) {
            retryTimer = setTimeout(() => setPeekRetryNonce((nonce) => nonce + 1), SNIPPET_PEEK_RETRY_MS);
          }
        });
    }

    return () => {
      cancelled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    entry.sessionId,
    entry.unreadCount,
    isPermission,
    awaitedPromptId,
    peekRetryNonce,
    snippetFreshnessMs,
    previewPushedByDesktop,
  ]);

  // No status filler ("Thinking", "Waiting for..."): the section header
  // and the icon already say the state. FIXED GEOMETRY: the snippet slot is
  // always exactly two lines tall and centres whatever it holds. A live
  // snippet changes length constantly (each new agent message replaces it),
  // and a slot that grew from one line to two shifted every card below it
  // mid-read. Reserving both lines up front costs one line of space and
  // buys a feed that never moves under the thumb.
  const snippetSlotHeight = theme.typography.caption.lineHeight * SNIPPET_LINES;
  const testID = `activity-row-${entry.sessionId}`;
  /**
   * Body preference, cheapest first:
   *   1. the desktop's pushed preview (protocol 0.8.0+) - already on a feed
   *      the app receives, so it costs no request at all;
   *   2. this row's own transcript peek - the fallback for an older desktop,
   *      and for a prompt-pending row whose summary is the pending decision;
   *   3. the task description from the board snapshot, so a card is never
   *      blank while either of the above is still resolving. It rides in on a
   *      snapshot the feed already has, so it costs nothing, while a peek is a
   *      transcript fetch that can take seconds on a long session. Without it
   *      the feed revealed with every body empty and filled them a beat later,
   *      which read as a second load.
   */
  const bodyText = (isPermission ? snippet : (entry.messagePreview ?? snippet)) ?? collapseToSnippetText(task.description);

  return (
    <>
      <TaskCard
        testID={testID}
        task={task}
        statusKind={statusKind}
        showTicketNumbers={false}
        usage={entry.usage}
        projectName={projectName}
        bodyText={bodyText}
        bodyNumberOfLines={SNIPPET_LINES}
        bodyMinHeight={snippetSlotHeight}
        onPress={openTask}
        onLongPress={onLongPress}
        overlay={
          <Animated.View
            pointerEvents="none"
            testID={`${testID}-pulse`}
            style={[styles.pulseOverlay, { backgroundColor: theme.colors.accent, borderRadius: theme.radii.md }, pulseStyle]}
          />
        }
      />
      {/* Inert in every shipped build (the probe flag is off): the idle-CPU
          mapper-count experiment only. See src/devsupport/MapperLoad.tsx. */}
      <MapperLoad />
    </>
  );
});

const styles = StyleSheet.create({
  pulseOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
