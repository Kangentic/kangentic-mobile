import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon, Row, Stack, Text, useTheme, type TextColorRole } from '@/components';
import { CapabilityError } from '@/channel';
import { archiveTask, deleteTaskFromBoard } from '@/connection/actions';
import { findTaskById, isDoneColumn, selectColumnsOrdered, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';

/**
 * Every row here needs both route params. Missing one is a routing defect the
 * user cannot act on, but a row that does NOTHING when tapped is worse than
 * one that admits it: a broken app and a deliberate refusal look identical
 * from the outside, and on the destructive row that is unforgivable.
 */
const MISSING_TASK_CONTEXT = 'Cannot act on this task - close and reopen it';

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

/**
 * The long-press hub for a task card, as a native form sheet route: the full
 * task lifecycle from the phone.
 *
 * Move and Edit REPLACE this route rather than pushing over it, so dismissing
 * the sheet they open returns to the board instead of to a menu the user has
 * already finished with.
 *
 * Delete is a two-step in-sheet confirm (tap arms it, a second tap within the
 * window fires) rather than a system Alert, so it stays themed and
 * Maestro-testable. Deleting also kills the task's live desktop session.
 */
export function TaskActionsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { taskId, projectId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();

  const task = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.task ?? null) : null));
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  // Archive is a move into the board's done-role column, so it needs one.
  const archiveAvailable = useMemo(
    () => (board ? selectColumnsOrdered(board).some(isDoneColumn) : false),
    [board],
  );

  const [actionInFlight, setActionInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const onMove = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    router.replace({ pathname: '/move-task', params: { taskId, projectId } });
  }, [taskId, projectId, router]);

  const onEdit = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    router.replace({ pathname: '/edit-task', params: { taskId, projectId } });
  }, [taskId, projectId, router]);

  const onArchive = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setActionInFlight(true);
    setErrorMessage(null);
    void archiveTask({ projectId, taskId })
      .then(() => router.back())
      .catch((error: unknown) => setErrorMessage(messageForActionError(error, 'Archive failed - check the connection')))
      .finally(() => setActionInFlight(false));
  }, [taskId, projectId, router]);

  /**
   * Two-step confirm: the first tap arms, the second fires. The armed state
   * ends when the user acts or the sheet goes away - never on a clock.
   *
   * It used to relax after ten seconds, and that deadline was invisible. The
   * row reverted to "Delete task" with no signal, so a confirm tap arriving a
   * beat late was silently reinterpreted as a FRESH arm: the user saw the
   * same words they had just tapped, no delete, and no reason, with no way to
   * tell a missed deadline from a broken app. It punished exactly the user
   * who stopped to read the consequence line. The expiry never did the job it
   * claimed either - an accidental rapid double-tap fires the delete whatever
   * the window is, because the guard is the second tap, not the clock - so
   * dropping it costs nothing that was ever there.
   */
  const onDeletePress = useCallback(() => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setActionInFlight(true);
    setErrorMessage(null);
    void deleteTaskFromBoard({ projectId, taskId })
      .then(() => {
        triggerHaptic('destructiveConfirmed');
        router.back();
      })
      .catch((error: unknown) => setErrorMessage(messageForActionError(error, 'Delete failed - check the connection')))
      .finally(() => setActionInFlight(false));
  }, [deleteArmed, taskId, projectId, router]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
      testID="task-actions-sheet"
    >
      <Stack gap="xs">
        <Text variant="title" numberOfLines={2}>
          {task ? task.title : 'Task'}
        </Text>
        <ActionRow
          label="Move to column"
          iconName="swap-horizontal"
          onPress={onMove}
          disabled={actionInFlight}
          testID="task-action-move"
        />
        <ActionRow
          label="Edit task"
          iconName="create"
          onPress={onEdit}
          disabled={actionInFlight}
          testID="task-action-edit"
        />
        <ActionRow
          label="Archive"
          iconName="archive"
          onPress={onArchive}
          disabled={actionInFlight || !archiveAvailable}
          caption={archiveAvailable ? null : 'No Done column on this board'}
          testID="task-action-archive"
        />
        <ActionRow
          label={deleteArmed ? 'Tap again to delete' : 'Delete task'}
          iconName="trash"
          color="danger"
          onPress={onDeletePress}
          disabled={actionInFlight}
          caption={deleteArmed ? 'Removes the task and stops its session on your desktop' : null}
          testID={deleteArmed ? 'task-action-delete-confirm' : 'task-action-delete'}
        />
        {errorMessage ? (
          <Text variant="caption" color="danger" testID="task-action-error">
            {errorMessage}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

function ActionRow({
  label,
  iconName,
  onPress,
  disabled,
  testID,
  color = 'primary',
  caption = null,
}: {
  label: string;
  iconName: React.ComponentProps<typeof Icon>['name'];
  onPress: () => void;
  disabled: boolean;
  testID: string;
  color?: TextColorRole;
  caption?: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.actionRow,
        {
          minHeight: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radii.md,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Row gap="sm" style={styles.actionRowContent}>
        <Icon name={iconName} color={color === 'danger' ? 'danger' : 'secondary'} size={20} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" color={color}>
            {label}
          </Text>
          {caption ? (
            <Text variant="caption" color="muted">
              {caption}
            </Text>
          ) : null}
        </Stack>
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    justifyContent: 'center',
    paddingVertical: 8,
  },
  actionRowContent: {
    alignItems: 'center',
  },
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  flex: {
    flex: 1,
  },
});
