import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, Text, useTheme } from '@/components';

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
export function SessionSwitchingState(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="session-switching-state"
      style={[styles.overlay, { backgroundColor: theme.colors.background }]}
      // Decorative over a live frame: announce the state, swallow taps meant
      // for a session that is no longer there.
      accessibilityRole="progressbar"
      accessibilityLabel="Switching to the new session for this task"
    >
      <Stack gap="xs" style={styles.content}>
        <Text variant="title">Switching session</Text>
        <Text variant="body" color="secondary" style={styles.caption}>
          The desktop is starting a new session for this task.
        </Text>
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
    /**
     * The last frame stays readable underneath. A scrim, not a curtain: the
     * point is that the session view is still there and is about to repaint.
     */
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
