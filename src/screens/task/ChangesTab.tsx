import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import type { DiffFileStatusWire, DiffFileWire, ReadDiffScope } from '@kangentic/protocol';
import {
  Badge,
  EmptyState,
  MonoText,
  Row,
  SegmentedTabBar,
  SkeletonRow,
  Stack,
  Text,
  useTheme,
  type SegmentedTabBarItem,
  type TextColorRole,
} from '@/components';
import { selectTaskDiff, useDiffStore } from '@/state/diffStore';
import { setDiffWatch } from '@/connection/actions';
import { splitPathForDisplay } from '@/diff/pathDisplay';

export interface ChangesTabProps {
  taskId: string;
  projectId: string | null;
  /** True while this tab is the visible one - the diff watch is screen-scoped. */
  isActive: boolean;
}

const SCOPE_ITEMS: SegmentedTabBarItem[] = [
  { key: 'working', label: 'Working' },
  { key: 'staged', label: 'Staged' },
  { key: 'branch', label: 'Branch' },
];

const LOADING_SKELETON_ROW_COUNT = 6;
const EMPTY_STATE_OVERSEER_SIZE = 54;

const BADGE_COLOR_BY_STATUS: Record<DiffFileStatusWire, TextColorRole> = {
  A: 'success',
  M: 'warning',
  D: 'danger',
  R: 'secondary',
  C: 'secondary',
  U: 'secondary',
};

function isReadDiffScope(value: string): value is ReadDiffScope {
  return value === 'working' || value === 'staged' || value === 'branch';
}

/**
 * The task's diff file list, live while the tab is visible: the diff watch
 * subscribes on focus/scope change and tears down on blur, and rows open the
 * per-file unified diff screen.
 */
export function ChangesTab({ taskId, projectId, isActive }: ChangesTabProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [scope, setScope] = useState<ReadDiffScope>('working');
  const taskDiff = useDiffStore((state) => selectTaskDiff(state, taskId));

  useEffect(() => {
    if (!isActive || projectId === null) return;
    setDiffWatch(taskId, { projectId, scope });
    return () => {
      // Also fires on a scope change; the next effect run re-sets the watch.
      setDiffWatch(taskId, null);
    };
  }, [isActive, scope, taskId, projectId]);

  const onScopeChange = useCallback((key: string) => {
    if (isReadDiffScope(key)) setScope(key);
  }, []);

  const openFile = useCallback(
    (file: DiffFileWire) => {
      if (projectId === null) return;
      router.push({
        pathname: '/file-diff',
        params: { taskId, projectId, path: file.path, scope },
      });
    },
    [router, taskId, projectId, scope],
  );

  const fileList = taskDiff?.fileList ?? null;

  let body: React.JSX.Element;
  if (projectId === null) {
    body = <CenteredNote color="secondary" message="No project linked to this task" />;
  } else if (fileList === null && taskDiff?.fileListStatus === 'error') {
    // Only when there is nothing else to show. A refresh that fails over a
    // list already on screen leaves that list up rather than blanking work the
    // user can still read; the next successful fetch clears the status.
    body = <CenteredNote color="danger" message="Could not load changes" />;
  } else if (fileList === null) {
    body = (
      <View testID="changes-skeleton" style={[styles.flex, { paddingVertical: theme.spacing.sm }]}>
        {Array.from({ length: LOADING_SKELETON_ROW_COUNT }, (_unused, rowIndex) => (
          <SkeletonRow key={`changes-skeleton-row-${rowIndex}`} />
        ))}
      </View>
    );
  } else if (fileList.files.length === 0) {
    body = <EmptyState testID="changes-empty" title="No changes" overseerSize={EMPTY_STATE_OVERSEER_SIZE} />;
  } else {
    body = (
      <FlashList<DiffFileWire>
        testID="changes-file-list"
        data={fileList.files}
        keyExtractor={(file) => file.path}
        renderItem={({ item, index }) => <FileRow file={item} index={index} onOpen={openFile} />}
        // All three session panes stay mounted, so the composer's keyboard can
        // still be up when this one is switched to. Without this the first tap
        // on a file row is spent dismissing it.
        keyboardShouldPersistTaps="handled"
      />
    );
  }

  return (
    <View style={styles.flex}>
      <SegmentedTabBar compact items={SCOPE_ITEMS} activeKey={scope} onChange={onScopeChange} testID="changes-scope" />
      {taskDiff?.stale === true ? (
        <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs }}>
          <Text variant="caption" color="muted" testID="changes-refreshing">
            refreshing...
          </Text>
        </View>
      ) : null}
      {body}
    </View>
  );
}

function CenteredNote({ color, message }: { color: TextColorRole; message: string }): React.JSX.Element {
  return (
    <Stack gap="sm" style={styles.centered}>
      <Text variant="body" color={color}>
        {message}
      </Text>
    </Stack>
  );
}

const FileRow = React.memo(function FileRow({
  file,
  index,
  onOpen,
}: {
  file: DiffFileWire;
  index: number;
  onOpen: (file: DiffFileWire) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { directory, basename } = splitPathForDisplay(file.path);

  const rowContent = (
    <Row gap="sm" style={styles.flex}>
      <Badge
        label={file.status}
        color={BADGE_COLOR_BY_STATUS[file.status]}
        align="center"
        testID={`changes-file-${index}-status`}
      />
      <MonoText size="body" numberOfLines={1} style={styles.flex}>
        {directory.length > 0 ? (
          <MonoText size="caption" color="muted">
            {directory}
          </MonoText>
        ) : null}
        {basename}
      </MonoText>
      {file.binary ? (
        <Badge label="binary" color="secondary" align="center" testID={`changes-file-${index}-binary`} />
      ) : (
        <Row gap="xs">
          <MonoText size="caption" style={{ color: theme.colors.diffAddText }}>
            {`+${file.insertions}`}
          </MonoText>
          <MonoText size="caption" style={{ color: theme.colors.diffRemoveText }}>
            {`-${file.deletions}`}
          </MonoText>
        </Row>
      )}
    </Row>
  );

  if (file.binary) {
    // Binary files have no textual diff to open; the row is informational only.
    return (
      <View
        testID={`changes-file-${index}`}
        style={[styles.fileRow, { minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md }]}
      >
        {rowContent}
      </View>
    );
  }

  return (
    <Pressable
      testID={`changes-file-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`Open diff for ${file.path}`}
      onPress={() => onOpen(file)}
      style={({ pressed }) => [
        styles.fileRow,
        { minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {rowContent}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileRow: {
    justifyContent: 'center',
  },
});
