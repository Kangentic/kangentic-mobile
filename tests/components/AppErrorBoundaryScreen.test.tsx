/**
 * The app's error boundary, exported as `ErrorBoundary` from app/_layout.tsx.
 *
 * The load-bearing behaviour is NOT the rendering, it is the reporting. React
 * hands a caught error to the boundary instead of to ErrorUtils, so the global
 * handler never sees it. Adding a boundary without an explicit capture would
 * trade a visible crash for an invisible one - strictly worse while iOS Sentry
 * delivery is still unproven. So the report is asserted first.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppErrorBoundaryScreen } from '@/screens/AppErrorBoundaryScreen';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockReportCaughtError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  reportCaughtError: (error: Error, boundary: string) => mockReportCaughtError(error, boundary),
}));

describe('AppErrorBoundaryScreen', () => {
  beforeEach(() => {
    mockReportCaughtError.mockClear();
  });

  it('reports the caught error, so a boundary cannot silently swallow a crash', () => {
    const error = new Error('render blew up');

    render(<AppErrorBoundaryScreen error={error} retry={async () => undefined} />);

    expect(mockReportCaughtError).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(error, 'root-layout');
  });

  it('renders a recovery affordance instead of a blank screen', () => {
    render(<AppErrorBoundaryScreen error={new Error('render blew up')} retry={async () => undefined} />);

    expect(screen.getByTestId('app-error-boundary')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('retries on press', () => {
    const retry = jest.fn(async () => undefined);

    render(<AppErrorBoundaryScreen error={new Error('render blew up')} retry={retry} />);
    fireEvent.press(screen.getByTestId('app-error-boundary-retry'));

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
