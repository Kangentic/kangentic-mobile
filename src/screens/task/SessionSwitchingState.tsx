import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Row, Stack, Text, useTheme } from '@/components';

export interface SessionSwitchingStateProps {
  /** Switches the task screen to the Changes pane; diffs outlive the swap. */
  onViewChanges: () => void;
}

/**
 * The honest surface for a task between two sessions.
 *
 * A column move that restarts the agent is a session SWAP on the wire: the
 * desktop suspends the old session (which pushes `session-ended`) and spawns
 * the successor seconds later. Rendering the ended state in that gap tells the
 * user their work is over when it is being handed to a new agent, and offers a
 * "View changes" button for a task that is mid-move.
 *
 * Unlike SessionEndedState this is a SCRIM, not an opaque panel: the dead
 * session's last frame stays visible behind it, so the screen reads as in
 * transit rather than blanked. The successor's first snapshot repaints it.
 *
 * No animation, deliberately. This can be on screen for the whole grace
 * window, and per motion-conventions.md an indicator that never stops holds
 * the app drawing at full frame rate for as long as it is mounted.
 */
export function SessionSwitchingState({ onViewChanges }: SessionSwitchingStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="session-switching-state"
      style={styles.overlay}
      // Modal to VoiceOver, so it cannot reach the covered pane behind the
      // scrim. Android has no equivalent on the overlay, so SessionScreen
      // hides the pane subtree there; the two together are the full fix.
      accessibilityViewIsModal
    >
      {/* The scrim is its OWN layer rather than opacity on this container:
          a container opacity fades the label and the button with it, and they
          sit over a live frame of arbitrary colour, which is where contrast
          goes. Painted first, so the content below it stacks on top. */}
      <View
        style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: theme.colors.background }]}
        pointerEvents="none"
      />
      {/* Announced as a live region rather than given a `progressbar` role on
          the container: that role made this whole overlay one atomic stop, and
          a screen reader could then miss the only button out of it. The
          visible text is the announcement. */}
      <Stack gap="xs" style={styles.content} accessibilityLiveRegion="polite">
        <Text variant="title">Switching session</Text>
        <Text variant="body" color="secondary" style={styles.caption}>
          The desktop is starting a new session.
        </Text>
        {/* The one way out while the panes are covered. A swap can run the
            whole grace window on a slow machine, and the work so far is still
            readable in the diff. */}
        <Row gap="sm" style={{ marginTop: theme.spacing.md }}>
          <Button
            label="View changes"
            variant="ghost"
            onPress={onViewChanges}
            testID="session-switching-view-changes"
          />
        </Row>
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    /**
     * Strictly above SessionScreen's panes, which carry `zIndex: 1` when
     * visible - the same stacking contest SessionEndedState documents. Raising
     * a pane's zIndex without raising this one puts the live frame back on top
     * and this overlay bleeds through the gaps.
     */
    zIndex: 2,
  },
  /**
   * The last frame stays readable underneath. A scrim, not a curtain: the
   * point is that the session view is still there and is about to repaint.
   * Opacity lives HERE, on the background layer alone, so the title, caption
   * and button above it keep full contrast.
   */
  scrim: {
    opacity: 0.92,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  caption: {
    textAlign: 'center',
  },
});
