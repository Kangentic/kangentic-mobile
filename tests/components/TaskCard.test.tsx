import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '@/components';
import { TaskCard, type TaskCardProps } from '@/components/board/TaskCard';
import { PR_READINESS_FRESHNESS_CAVEAT } from '@/components/board/prChipPresentation';
import { boardTaskFixture, usageFixture } from '@/devsupport/desktopFixtures';

const BASE_TEST_ID = 'task-card';

function renderTaskCard(overrides: Partial<TaskCardProps> = {}): void {
  const props: TaskCardProps = {
    testID: BASE_TEST_ID,
    task: boardTaskFixture(),
    statusKind: null,
    showTicketNumbers: false,
    usage: null,
    bodyText: 'A task worth doing.',
    onPress: jest.fn(),
    ...overrides,
  };
  render(
    <ThemeProvider>
      <TaskCard {...props} />
    </ThemeProvider>,
  );
}

/**
 * The labels Row never carries its own testID (only its children do), so
 * the only way to reach it and fire its onLayout handler is to start from a
 * rendered label and walk up the tree to the nearest ancestor that actually
 * owns the handler.
 */
function findAncestorWithLayoutHandler(instance: ReactTestInstance): ReactTestInstance {
  let currentInstance: ReactTestInstance | null = instance;
  while (currentInstance !== null) {
    if (typeof currentInstance.props.onLayout === 'function') return currentInstance;
    currentInstance = currentInstance.parent;
  }
  throw new Error('No ancestor with an onLayout handler was found.');
}

describe('TaskCard', () => {
  it('every sub-part testID is queryable - regression guard for lucide forwarding testID as the web-only data-testid, which RNTL cannot select unless the glyph is wrapped', () => {
    renderTaskCard({
      task: boardTaskFixture({ pr_number: 42 }),
      statusKind: 'working',
      showTicketNumbers: true,
      usage: usageFixture(),
      projectName: 'Kangentic Mobile',
      bodyText: 'A live inbox-style snippet.',
    });

    expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-usage`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-project`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-display-id`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-status`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-snippet`)).toBeTruthy();
  });

  it('renders the utility strip for an over-budget usage report instead of hiding it - desktop parity for a critical, not untrustworthy, state', () => {
    // Kills a restoration of the old hide-when-over-budget gate
    // (`isContextWindowKnown(usage) && usedTokens <= contextWindowSize`):
    // that mutation stays green against every other fixture in this file,
    // which all report usedTokens comfortably under contextWindowSize.
    renderTaskCard({
      usage: usageFixture({
        contextWindow: {
          usedPercentage: 92,
          usedTokens: 210_000,
          cacheTokens: 800,
          totalInputTokens: 3200,
          totalOutputTokens: 500,
          contextWindowSize: 200_000,
        },
      }),
    });

    expect(screen.getByTestId(`${BASE_TEST_ID}-usage`)).toBeTruthy();
  });

  it('showMetaRow={false} suppresses the labels row and the PR icon - its only coverage, since no caller passes this yet', () => {
    renderTaskCard({
      task: boardTaskFixture({ pr_number: 42, labels: ['backend', 'p0'] }),
      showMetaRow: false,
    });

    expect(screen.queryByTestId(`${BASE_TEST_ID}-pr`)).toBeNull();
    expect(screen.queryByText('backend')).toBeNull();
    expect(screen.queryByText('p0')).toBeNull();
  });

  describe('PR merge readiness', () => {
    it('labels the chip while the PR is open and the verdict says something', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'conflicting' }),
      });

      // Text, not color: a color assertion passes by accident the moment the
      // token it reads happens to match. The wire says `conflicting`; the card
      // must say `conflicts`.
      expect(screen.getByText('conflicts')).toBeTruthy();
      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
    });

    it('spends no title width on an open PR with no verdict', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: null }),
      });

      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
      expect(screen.queryByText('open')).toBeNull();
      expect(screen.queryByText('ready')).toBeNull();
    });

    it('never shows a stale verdict on a merged PR', () => {
      // The desktop stops refreshing readiness once a PR lands, so this is
      // what the wire really looks like afterwards. Seen failing against a
      // mutation that consulted readiness outside the open branch.
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 103, pr_state: 'merged', pr_merge_readiness: 'ready' }),
      });

      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
      expect(screen.queryByText('ready')).toBeNull();
    });

    it('reaches a screen reader as its own node, carrying the freshness caveat', () => {
      // The Card around this is pressable, so an `accessible` View nested
      // inside it could have been collapsed into the card's own label. This
      // asserts the node actually resolves rather than assuming it does.
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'blocked' }),
      });

      expect(screen.getByLabelText(new RegExp(PR_READINESS_FRESHNESS_CAVEAT))).toBeTruthy();
    });
  });

  describe('label overflow', () => {
    const manyLabels = ['backend', 'notifications', 'migration', 'breaking-change', 'p0'];

    it('shows the fallback limit (3) before the labels row has been measured', () => {
      renderTaskCard({ task: boardTaskFixture({ labels: manyLabels }) });

      expect(screen.getByText('backend')).toBeTruthy();
      expect(screen.getByText('notifications')).toBeTruthy();
      expect(screen.getByText('migration')).toBeTruthy();
      expect(screen.queryByText('breaking-change')).toBeNull();
      expect(screen.queryByText('p0')).toBeNull();
      expect(screen.getByText('+2')).toBeTruthy();
    });

    it('recomputes the visible count once the labels row reports its real width', () => {
      renderTaskCard({ task: boardTaskFixture({ labels: manyLabels }) });

      const labelsRow = findAncestorWithLayoutHandler(screen.getByText('backend'));
      fireEvent(labelsRow, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 24 } } });

      // At 300px, computeVisibleLabelCount fits exactly 2 (see labelFit.test.ts).
      expect(screen.getByText('backend')).toBeTruthy();
      expect(screen.getByText('notifications')).toBeTruthy();
      expect(screen.queryByText('migration')).toBeNull();
      expect(screen.getByText('+3')).toBeTruthy();
    });
  });
});
