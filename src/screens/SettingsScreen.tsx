import React, { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import type { PushCategory } from '@kangentic/protocol';
import { Brandmark, Button, Card, Icon, MonoText, Row, Screen, SectionHeader, Stack, StatusDot, Text, useTheme } from '@/components';
import { resyncPushRegistrationCategories } from '@/connection/connectionManager';
import {
  getBackgroundPushTaskStatus,
  getPushRegistrationStatus,
  notificationPermissionStatus,
  openSystemNotificationSettings,
  refreshNotificationPermission,
  type BackgroundPushTaskStatus,
  type NotificationPermissionStatus,
  type PushRegistrationStatus,
} from '@/notifications';
import {
  RETENTION_PROBE_VARIANTS,
  retentionProbeEnabled,
  setRetentionProbeVariant,
  useRetentionProbeVariant,
} from '@/devsupport/retentionProbe';
import { crashNatively, crashTestEnabled, reportHandledTestError, throwTestError } from '@/observability/crashReporting';
import { useChannelStore } from '@/state/channelStore';
import {
  useSettingsStore,
  type BackgroundNotificationsMode,
  type DictationMode,
} from '@/state/settingsStore';

const PUSH_STATUS_LABELS: Record<PushRegistrationStatus, string> = {
  registered: 'Remote push: registered',
  // States the consequence, not just the fact: with no FCM there is no push to
  // take over when the background keepalive hits its five-minute ceiling, so
  // this is the one build where alerting genuinely stops rather than handing off.
  'unavailable-no-fcm': 'Remote push: off on this build - brief background alerts only',
  'capability-denied': 'Remote push: not granted by your desktop',
  'not-connected': 'Remote push: registers on connect',
  pending: 'Remote push: registering...',
};

/**
 * The headless receive task is a SECOND, independent way remote push can be
 * dead. The verb can register this device's token with the desktop perfectly
 * while the task that would DISPLAY the result never registered - pushes are
 * then sent, delivered, and silently never seen.
 *
 * IT OVERRIDES 'registered' AND NOTHING ELSE, which is narrower than it first
 * looks and deliberately so. 'registered' is the only label that claims
 * success, so it is the only one that can be actively wrong. Every other status
 * already tells the user push is not working, and the most likely companion -
 * 'unavailable-no-fcm', since a build with no google-services.json fails BOTH
 * the token fetch and this task registration - says it better than a generic
 * line could: it names the consequence (alerting stops when the keepalive hits
 * its ceiling) rather than just the fact. Overriding unconditionally would
 * replace the good copy with the vague copy in exactly the configuration the
 * good copy was written for.
 */
function resolvePushStatusLabel(
  registrationStatus: PushRegistrationStatus,
  taskStatus: BackgroundPushTaskStatus,
): string {
  if (taskStatus === 'unavailable' && registrationStatus === 'registered') {
    return 'Remote push: unavailable on this device';
  }
  return PUSH_STATUS_LABELS[registrationStatus];
}

/**
 * These govern the CHAT composer's mic only. The terminal used to carry its
 * own dictation button; it was removed, and raising the keyboard there gives
 * you the OS mic instead. Auto-send is the reason this setting still earns
 * its place: speaking and sending in one gesture is the one thing keyboard
 * dictation cannot do.
 */
const DICTATION_OPTIONS: { mode: DictationMode; label: string; description: string; testID: string }[] = [
  {
    mode: 'auto-send',
    label: 'Auto-send',
    description: 'Sends when you stop speaking',
    testID: 'settings-dictation-auto-send',
  },
  {
    mode: 'manual-send',
    label: 'Review before sending',
    description: 'Fills the composer; you tap send',
    testID: 'settings-dictation-manual-send',
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'Hides the composer mic',
    testID: 'settings-dictation-off',
  },
];

const NOTIFICATION_MODE_OPTIONS: {
  mode: BackgroundNotificationsMode;
  label: string;
  description: string;
  testID: string;
}[] = [
  {
    mode: 'foreground-service',
    label: 'Stay connected',
    description: 'Instant alerts via a quiet notification',
    testID: 'settings-notifications-foreground-service',
  },
  {
    mode: 'push-only',
    label: 'Push only',
    description: 'Encrypted push wakes the app when needed',
    testID: 'settings-notifications-push-only',
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'No background alerts',
    testID: 'settings-notifications-off',
  },
];

/**
 * 'foreground-service' is Android-only in fact, not just in emphasis: the
 * keepalive gate in connectionManager requires Platform.OS === 'android', so on
 * iOS the option is inert and offering it is a lie about what the app will do.
 * Hide it there.
 *
 * The STORED value is left alone. An iOS user whose setting says
 * 'foreground-service' (the default, or carried from an Android install) reads
 * back as 'push-only' for display only, which is what actually happens; tapping
 * writes the real value, so nothing is silently rewritten behind them.
 */
function visibleNotificationModeOptions(): typeof NOTIFICATION_MODE_OPTIONS {
  if (Platform.OS === 'android') return NOTIFICATION_MODE_OPTIONS;
  return NOTIFICATION_MODE_OPTIONS.filter((option) => option.mode !== 'foreground-service');
}

function selectedNotificationMode(mode: BackgroundNotificationsMode): BackgroundNotificationsMode {
  if (Platform.OS === 'android' || mode !== 'foreground-service') return mode;
  return 'push-only';
}

const PUSH_CATEGORY_OPTIONS: { category: PushCategory; label: string; description: string; testID: string }[] = [
  {
    category: 'input-required',
    label: 'Needs your input',
    description: 'Approvals and questions',
    testID: 'settings-category-input-required',
  },
  {
    // Wire id unchanged; the meaning moved. Both producers now settle-debounce
    // this, so it marks a session going quiet rather than each turn ending.
    category: 'turn-complete',
    label: 'Agent went idle',
    description: 'When a session settles',
    testID: 'settings-category-turn-complete',
  },
  {
    category: 'session-failed',
    label: 'Session failed',
    description: 'A session stopped unexpectedly',
    testID: 'settings-category-session-failed',
  },
  {
    category: 'plan-complete',
    label: 'Plan complete',
    description: 'A plan was approved',
    testID: 'settings-category-plan-complete',
  },
  {
    category: 'spawn-stalled',
    label: 'Slow starts',
    description: 'A task is taking a while to start',
    testID: 'settings-category-spawn-stalled',
  },
];

export function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  const setDictationMode = useSettingsStore((state) => state.setDictationMode);
  const backgroundNotificationsMode = useSettingsStore((state) => state.backgroundNotificationsMode);
  const setBackgroundNotificationsMode = useSettingsStore((state) => state.setBackgroundNotificationsMode);
  const hapticsEnabled = useSettingsStore((state) => state.hapticsEnabled);
  const setHapticsEnabled = useSettingsStore((state) => state.setHapticsEnabled);
  const pushCategoriesEnabled = useSettingsStore((state) => state.pushCategoriesEnabled);
  const setPushCategoryEnabled = useSettingsStore((state) => state.setPushCategoryEnabled);
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);
  const relayUrl = useChannelStore((state) => state.relayUrl);
  const pairedState = useChannelStore((state) => state.pairedState);
  const retentionProbeVariant = useRetentionProbeVariant();

  const connectionLabel =
    pairedState === 'unpaired'
      ? 'Not paired'
      : established
        ? 'Connected'
        : transportState === 'idle'
          ? 'Not connected'
          : transportState;

  const appVersion = Constants.expoConfig?.version ?? null;

  return (
    <Screen testID="settings-screen">
      {/* Grouped settings cards: each concern in one surface, footnotes
          under their card, generous rhythm between groups. */}
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingTop: theme.spacing.sm, gap: theme.spacing.lg }}>
        <Stack gap="xs">
          <SectionHeader title="Connection" testID="settings-section-connection" />
          <Card>
            <Stack gap="sm">
              <Row gap="sm" style={styles.connectionRow}>
                <StatusDot variant={established ? 'working' : 'idle'} testID="settings-connection-dot" />
                <Text variant="bodyStrong" style={styles.flex} testID="settings-connection-label">
                  {connectionLabel}
                </Text>
              </Row>
              {relayUrl ? (
                <View>
                  <Text variant="caption" color="muted">
                    Relay
                  </Text>
                  <MonoText size="caption" numberOfLines={1} testID="settings-relay-url">
                    {relayUrl}
                  </MonoText>
                </View>
              ) : null}
              <RowDivider />
              <Pressable
                accessibilityRole="button"
                testID="settings-devices-row"
                onPress={() => router.push('/devices')}
                style={({ pressed }) => [styles.linkRow, { minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
              >
                {/* Singular, because the phone holds exactly ONE desktop
                    trust anchor. "Paired devices" promised a list and a
                    choice that cannot exist, and the screen behind it shows
                    one desktop - so the label was writing a cheque the
                    product does not cash. */}
                <Text variant="body" color="primary">
                  Paired desktop
                </Text>
                <Icon name="chevron-forward" color="muted" size={16} />
              </Pressable>
              {pairedState === 'unpaired' ? (
                // Unpaired is the setup moment: the pair CTA is the hero.
                // Once paired, this phone holds exactly ONE desktop trust
                // anchor - re-pairing REPLACES it, so that action lives in
                // the Devices screen next to unpair, stated as a replace.
                <Button testID="settings-pair-device" label="Pair" onPress={() => router.push('/pair')} />
              ) : null}
            </Stack>
          </Card>
        </Stack>

        <Stack gap="xs">
          <SectionHeader title="Notifications" testID="settings-section-notifications" />
          <Card>
            <Stack gap="xs">
              {visibleNotificationModeOptions().map((option, optionIndex) => (
                <React.Fragment key={option.mode}>
                  {optionIndex > 0 ? <RowDivider /> : null}
                  <RadioRow
                    label={option.label}
                    description={option.description}
                    selected={option.mode === selectedNotificationMode(backgroundNotificationsMode)}
                    testID={option.testID}
                    onPress={() => void setBackgroundNotificationsMode(option.mode)}
                  />
                </React.Fragment>
              ))}
            </Stack>
          </Card>
          <NotificationPermissionNotice />
          <PushRegistrationStatusLine />
        </Stack>

        <Stack gap="xs">
          <SectionHeader title="Alert me for" testID="settings-section-categories" />
          <Card>
            <Stack gap="xs">
              {PUSH_CATEGORY_OPTIONS.map((option, optionIndex) => (
                <React.Fragment key={option.category}>
                  {optionIndex > 0 ? <RowDivider /> : null}
                  <SwitchRow
                    label={option.label}
                    description={option.description}
                    checked={pushCategoriesEnabled[option.category] !== false}
                    testID={option.testID}
                    onValueChange={(enabled) =>
                      void setPushCategoryEnabled(option.category, enabled).then(() => resyncPushRegistrationCategories())
                    }
                  />
                </React.Fragment>
              ))}
            </Stack>
          </Card>
        </Stack>

        <Stack gap="xs">
          <SectionHeader title="Feedback" testID="settings-section-feedback" />
          <Card>
            <SwitchRow
              label="Haptic feedback"
              description="A light tap on meaningful actions"
              checked={hapticsEnabled}
              testID="settings-haptics-toggle"
              onValueChange={(enabled) => void setHapticsEnabled(enabled)}
            />
          </Card>
        </Stack>

        <Stack gap="xs">
          <SectionHeader title="Chat dictation" testID="settings-section-dictation" />
          <Card>
            <Stack gap="xs">
              {DICTATION_OPTIONS.map((option, optionIndex) => (
                <React.Fragment key={option.mode}>
                  {optionIndex > 0 ? <RowDivider /> : null}
                  <RadioRow
                    label={option.label}
                    description={option.description}
                    selected={option.mode === dictationMode}
                    testID={option.testID}
                    onPress={() => void setDictationMode(option.mode)}
                  />
                </React.Fragment>
              ))}
            </Stack>
          </Card>
        </Stack>

        {crashTestEnabled() ? (
          <Stack gap="xs">
            <SectionHeader title="Crash reporting test" testID="settings-section-crash-test" />
            <Card>
              <Stack gap="xs">
                <Pressable
                  accessibilityRole="button"
                  testID="settings-crash-test-js"
                  onPress={throwTestError}
                  style={({ pressed }) => [styles.linkRow, { minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text variant="body" color="primary">
                    Throw a JS error
                  </Text>
                  <Icon name="chevron-forward" color="muted" size={16} />
                </Pressable>
                <RowDivider />
                <Pressable
                  accessibilityRole="button"
                  testID="settings-crash-test-native"
                  onPress={crashNatively}
                  style={({ pressed }) => [styles.linkRow, { minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text variant="body" color="primary">
                    Crash natively
                  </Text>
                  <Icon name="chevron-forward" color="muted" size={16} />
                </Pressable>
                <RowDivider />
                <Pressable
                  accessibilityRole="button"
                  testID="settings-crash-test-handled"
                  onPress={reportHandledTestError}
                  style={({ pressed }) => [styles.linkRow, { minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text variant="body" color="primary">
                    Report handled error
                  </Text>
                  <Icon name="chevron-forward" color="muted" size={16} />
                </Pressable>
              </Stack>
            </Card>
          </Stack>
        ) : null}

        {retentionProbeEnabled() ? (
          <Stack gap="xs">
            <SectionHeader title="Retention probe" testID="settings-section-retention-probe" />
            <Card>
              <Stack gap="xs">
                {RETENTION_PROBE_VARIANTS.map((option, optionIndex) => (
                  <React.Fragment key={option.variant}>
                    {optionIndex > 0 ? <RowDivider /> : null}
                    <RadioRow
                      label={option.label}
                      description={option.description}
                      selected={option.variant === retentionProbeVariant}
                      testID={`settings-retention-probe-${option.variant}`}
                      onPress={() => setRetentionProbeVariant(option.variant)}
                    />
                  </React.Fragment>
                ))}
              </Stack>
            </Card>
          </Stack>
        ) : null}

        <Stack gap="xs">
          <SectionHeader title="About" testID="settings-section-about" />
          <Card>
            <Row gap="md" style={styles.aboutRow} testID="settings-about-row">
              <Brandmark size={40} testID="settings-about-brandmark" />
              <View style={styles.flex}>
                <Text variant="bodyStrong">Kangentic Mobile</Text>
                <Text variant="caption" color="muted">
                  {appVersion !== null ? `Version ${appVersion}` : 'Development build'}
                </Text>
              </View>
            </Row>
          </Card>
        </Stack>
      </ScrollView>
    </Screen>
  );
}

/** Hairline separator between rows inside one settings card. */
function RowDivider(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />;
}

/**
 * Shown when the notification permission has been asked for AND refused,
 * because at that point every notification mode above is inert: local alerts
 * and remote push both need it. Cross-platform - an iOS user whose
 * authorization is denied previously saw a screen full of enabled-looking
 * toggles and nothing else, which is exactly the state the bug reporter was in.
 *
 * THE TWO PLATFORMS ANSWER "have we asked?" DIFFERENTLY, and the difference is
 * why this is not one condition:
 *
 * - iOS reports NOT_DETERMINED, so the OS itself says whether anyone has been
 *   asked. Read it directly. It is also the ONLY trustworthy source there: iOS
 *   Keychain items survive app deletion, so the persisted flag can outlive the
 *   authorization it describes and would tell a reinstalled app it had already
 *   asked when it had not.
 * - Android has no NOT_DETERMINED - notifee reports only DENIED or AUTHORIZED -
 *   so a permission nobody has requested reads back identically to one that was
 *   refused, and initializeNotifications seeds the cache at boot. Keying on the
 *   cache alone would tell a brand-new user that notifications are blocked
 *   before the app had ever asked, on a screen whose only offered remedy is a
 *   trip to system settings. The persisted hasRequestedNotificationPermission
 *   flag is the only record that we asked.
 *
 * A button rather than another in-app prompt on purpose. Android stops showing
 * the runtime prompt after two dismissals and iOS asks exactly once ever;
 * thereafter requestNotificationPermission() just resolves denied without
 * displaying anything, so system settings is the only recovery path that works.
 */
function NotificationPermissionNotice(): React.JSX.Element | null {
  // Seeded synchronously from the cache rather than by an async read on mount.
  // The cache is already current by the time this screen can be reached:
  // initializeNotifications seeds it at boot and the connection lifecycle
  // refreshes it on every foreground.
  const [status, setStatus] = useState<NotificationPermissionStatus | null>(() => notificationPermissionStatus());
  const hasRequestedNotificationPermission = useSettingsStore((state) => state.hasRequestedNotificationPermission);

  useEffect(() => {
    // Returning from the system settings screen fires 'active', which is the
    // only moment a grant made outside the app becomes visible to it. The
    // lifecycle refreshes on the same event, but this cannot read its result
    // off the cache - both are reacting to the same tick.
    const subscription = AppState.addEventListener('change', (appStateStatus) => {
      if (appStateStatus !== 'active') return;
      void refreshNotificationPermission()
        .then(() => setStatus(notificationPermissionStatus()))
        .catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  if (status !== 'denied') return null;
  if (Platform.OS === 'android' && !hasRequestedNotificationPermission) return null;
  return (
    <Card>
      <Stack gap="sm">
        <Text variant="bodyStrong">Notifications are blocked</Text>
        <Text variant="caption" color="muted">
          No alerts can reach you until you allow them.
        </Text>
        <Button
          testID="settings-open-notification-settings"
          label="Open settings"
          onPress={() => void openSystemNotificationSettings()}
        />
      </Stack>
    </Card>
  );
}

function PushRegistrationStatusLine(): React.JSX.Element {
  const established = useChannelStore((state) => state.established);
  // The status is a module-level snapshot, not a store: re-read it when the
  // channel state changes (registration rides established bootstraps).
  const [status, setStatus] = useState<PushRegistrationStatus>(() => getPushRegistrationStatus());
  // Settles at boot rather than on establish, but rides the same refresh: one
  // snapshot read is cheaper than a second timer for a value that only moves once.
  const [taskStatus, setTaskStatus] = useState<BackgroundPushTaskStatus>(() => getBackgroundPushTaskStatus());
  useEffect(() => {
    // A beat after the channel establishes, registration has usually run.
    const refreshTimer = setTimeout(() => {
      setStatus(getPushRegistrationStatus());
      setTaskStatus(getBackgroundPushTaskStatus());
    }, 1500);
    return () => clearTimeout(refreshTimer);
  }, [established]);

  return (
    <Text variant="caption" color="muted" testID="settings-push-status">
      {resolvePushStatusLabel(status, taskStatus)}
    </Text>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  testID,
  onValueChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  testID: string;
  onValueChange: (enabled: boolean) => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked }}
      testID={testID}
      onPress={() => onValueChange(!checked)}
      style={({ pressed }) => [styles.switchRow, { minHeight: theme.minTouchSize, gap: theme.spacing.sm, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.radioLabels}>
        <Text variant="body" color="primary">
          {label}
        </Text>
        <Text variant="caption" color="secondary">
          {description}
        </Text>
      </View>
      {/*
        Presentational only: the wrapping Pressable owns the switch role,
        the checked state, and the tap. Letting the native Switch keep its
        own touch handling and accessibility node would put two switch
        nodes in one row (duplicate screen-reader announcements) and let a
        tap on the thumb fire both handlers - a doubled SecureStore write
        and a doubled register-push resync per tap.
      */}
      <Switch
        value={checked}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        trackColor={{ false: theme.colors.border, true: theme.colors.accentMuted }}
        thumbColor={checked ? theme.colors.accent : theme.colors.textMuted}
      />
    </Pressable>
  );
}

function RadioRow({
  label,
  description,
  selected,
  testID,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  testID: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.radioRow,
        {
          minHeight: theme.minTouchSize,
          gap: theme.spacing.sm,
          paddingVertical: theme.spacing.xs,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={selected ? 'accent' : 'secondary'} />
      <View style={styles.radioLabels}>
        <Text variant="body" color="primary">
          {label}
        </Text>
        <Text variant="caption" color="secondary">
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  radioLabels: {
    flex: 1,
  },
  connectionRow: {
    alignItems: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aboutRow: {
    alignItems: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  flex: {
    flex: 1,
  },
});
