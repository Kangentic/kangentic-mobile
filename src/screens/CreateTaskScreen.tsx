import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, SheetScrollerSlot, Stack, Text, TextField, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { createTask } from '@/connection/actions';
import { reportHandledError } from '@/observability/crashReporting';
import { selectColumnsOrdered, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  CREATE_SHEET_RESERVED_HEIGHT,
  DESCRIPTION_FLOOR_HEIGHT,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

const BACKLOG_COLUMN_NAME = 'Backlog';

/** The empty box's resting height, when the window's cap leaves it room. */
const DESCRIPTION_PREFERRED_MIN_HEIGHT = 120;

/**
 * New-task form, presented as a NATIVE form sheet (see app/_layout.tsx's
 * `presentation: 'formSheet'`), not a hand-rolled Modal.
 *
 * The custom Sheet this replaced put a bottom-anchored card inside a
 * transparent Android Dialog and did its own keyboard avoidance. That is a
 * layout race we do not want to own: on first open the dialog window had not
 * settled edge-to-edge yet, so the card rendered one tab-bar-height above the
 * screen bottom with the Agents/Board tabs showing underneath, and only
 * snapped flush once the keyboard forced a relayout. Reported from the device
 * as "it opens just above the navigation icons, then typing pins it".
 *
 * A form sheet has no such window to miss: the platform owns the presentation
 * (UISheetPresentationController on iOS, the Compose bottom sheet on Android),
 * the backdrop, and keyboard avoidance, identically on both. There is
 * deliberately no KeyboardAvoidingView or backdrop Pressable here - adding
 * either would be fighting the platform for a job it already does. (The
 * container's bottom inset padding is spacing, not avoidance: 'fitToContents'
 * hugs the content, so the button needs clearance from the gesture bar.)
 */
export function CreateTaskScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  // Select the BOARD (a stable store reference), never the derived array:
  // selectColumnsOrdered builds a new array per call, so returning it straight
  // from the selector changes identity every render and drives
  // useSyncExternalStore into an infinite loop. Same rule as SessionScreen.
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);

  const { height: windowHeight } = useWindowDimensions();
  /**
   * The description box is sized by its CONTENT, not pinned: a multiline
   * TextInput with no fixed height grows to fit, and 'fitToContents' grows
   * the sheet with it, so the sheet is as tall as what is actually being
   * written.
   *
   * Fractional detents were tried instead of all this and are worse: a
   * fixed-fraction sheet does not shrink when the keyboard opens, so its
   * lower third - the column chips and the Create button - became
   * unreachable. 'fitToContents' is what keeps the sheet clear of the
   * keyboard, and this cap is what keeps 'fitToContents' honest: it derives
   * from the window height so the whole keyboard-up sheet fits above the
   * keyboard on small phones too (a fixed 420 did not, per the 2026-08-15
   * iOS tester recording), and it is aligned to the text line grid so an
   * overflowing description clips at a whole line instead of mid-line.
   */
  const descriptionMaxHeight = alignHeightToTextLineGrid({
    height: clampSheetContentHeight({
      windowHeight,
      reservedHeight: CREATE_SHEET_RESERVED_HEIGHT + insets.bottom + SHEET_KEYBOARD_ALLOWANCE,
      floorHeight: DESCRIPTION_FLOOR_HEIGHT,
    }),
    lineHeight: theme.typography.body.lineHeight,
    verticalPadding: 2 * theme.spacing.sm,
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // null = untouched, so the default column stays selected until an explicit
  // tap. The screen unmounts on dismiss, so there is nothing to reset.
  const [pickedColumnName, setPickedColumnName] = useState<string | null>(null);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Always the board's first column (To Do by convention), never whichever
  // column the pager happened to be showing: a new task is new work.
  const defaultColumnName = columns[0]?.name ?? null;
  const columnName = pickedColumnName ?? defaultColumnName ?? BACKLOG_COLUMN_NAME;
  const columnChoices = useMemo(() => [...columns.map((column) => column.name), BACKLOG_COLUMN_NAME], [columns]);

  const confirm = useCallback(() => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0 || !projectId) return;
    setCreateInFlight(true);
    setErrorMessage(null);
    void createTask({ projectId, title: trimmedTitle, description: description.trim(), column: columnName })
      .then(() => {
        triggerHaptic('taskCreated');
        router.back();
      })
      .catch((error: unknown) => {
        reportHandledError('create-task', error);
        setErrorMessage(error instanceof CapabilityError ? error.message : 'Create failed - check the connection');
      })
      .finally(() => setCreateInFlight(false));
  }, [projectId, title, description, columnName, router]);

  return (
    <View
      testID="create-task-sheet"
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          // 'fitToContents' hugs the content exactly, so the Create button
          // would otherwise sit hard against the sheet's bottom edge. The
          // safe-area inset on top of that keeps it clear of the gesture bar.
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
    >
      <Stack gap="sm">
        <Text variant="title">New task</Text>
        <TextField value={title} onChangeText={setTitle} placeholder="Title" testID="create-task-title" autoFocus />
        {/*
          Plain TextField, not DictationTextField: a custom in-field mic button
          left a column of dead space beside a tall multiline box and duplicated
          the keyboard's own voice-typing button. A fixed height rather than
          flex: 1 - 'fitToContents' sizes the sheet from its content, and a
          flexing child gives it nothing to measure.
        */}
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description (optional)"
          multiline
          testID="create-task-description"
          style={{
            maxHeight: descriptionMaxHeight,
            // minHeight follows the cap: in layout, minHeight beats maxHeight,
            // so a fixed floor above a tiny window's cap would grow the box
            // right back past it.
            minHeight: Math.min(DESCRIPTION_PREFERRED_MIN_HEIGHT, descriptionMaxHeight),
          }}
        />
        {/* keyboardShouldPersistTaps is not inherited from an outer scroll
            view, and defaults to "never": without it the first tap on a chip
            is spent dismissing the keyboard and the column never changes. */}
        <SheetScrollerSlot>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            testID="create-task-column-scroller"
          >
            <View style={[styles.columnChips, { gap: theme.spacing.xs }]}>
              {columnChoices.map((choiceName) => {
                const isSelected = columnName === choiceName;
                return (
                  <Pressable
                    key={choiceName}
                    testID={`create-task-column-${choiceName}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setPickedColumnName(choiceName)}
                    style={[
                      styles.columnChip,
                      {
                        minHeight: theme.minTouchSize,
                        paddingHorizontal: theme.spacing.md,
                        borderRadius: theme.radii.md,
                        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                        backgroundColor: isSelected ? theme.colors.surfaceRaised : 'transparent',
                      },
                    ]}
                  >
                    <Text variant="body" color={isSelected ? 'primary' : 'secondary'}>
                      {choiceName}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </SheetScrollerSlot>

        {errorMessage ? (
          <Text variant="caption" color="danger">
            {errorMessage}
          </Text>
        ) : null}

        <Button
          label={createInFlight ? 'Creating...' : 'Create task'}
          onPress={confirm}
          disabled={title.trim().length === 0 || createInFlight}
          testID="create-task-confirm"
        />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  columnChip: {
    alignItems: 'center',
    justifyContent: 'center',
    // A full 1px border, not hairlineWidth: a sub-pixel border on a rounded
    // corner anti-aliases into visible jagged pixelation at the selected
    // chip's full-saturation accent color.
    borderWidth: 1,
  },
  columnChips: {
    flexDirection: 'row',
  },
  container: {
    // Deliberately NOT flex: 1 - see the sheetAllowedDetents note above.
    width: '100%',
  },
});
