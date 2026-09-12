import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';
import { IconButton, Row, Text, TextField, useTheme } from '@/components';
import { sendUserMessage } from '@/connection/actions';
import { reportHandledError } from '@/observability/crashReporting';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useDictation } from '@/voice/useDictation';

export interface ComposerBarProps {
  sessionId: string;
}

const COMPOSER_MAX_HEIGHT = 120;

/** Appends dictated text to whatever was typed before dictation began, inserting one space if needed. */
function joinDictationText(baseText: string, dictatedText: string): string {
  if (baseText.length === 0) return dictatedText;
  if (dictatedText.length === 0) return baseText;
  const separator = /\s$/.test(baseText) ? '' : ' ';
  return `${baseText}${separator}${dictatedText}`;
}

/**
 * The conversation footer: a growing multiline input, a send button gated on
 * channel establishment, and a dictation mic (hidden when dictation is off
 * or the engine is unavailable). Partial dictation results stream into the
 * input; a final result auto-sends when the setting says so.
 */
export function ComposerBar({ sessionId }: ComposerBarProps): React.JSX.Element {
  const theme = useTheme();
  const established = useChannelStore((state) => state.established);
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  // Mirror of `text` for callbacks that must read the latest value without re-binding.
  const textRef = useRef('');
  // What was in the input when dictation began; partials append after this.
  const dictationBaseRef = useRef('');

  const updateText = useCallback((nextText: string) => {
    textRef.current = nextText;
    setText(nextText);
  }, []);

  const sendText = useCallback(
    (messageText: string) => {
      const trimmedText = messageText.trim();
      if (trimmedText.length === 0) return;
      setSending(true);
      setErrorNote(null);
      void sendUserMessage(sessionId, trimmedText)
        .then(() => {
          textRef.current = '';
          dictationBaseRef.current = '';
          setText('');
        })
        .catch((error: unknown) => {
          reportHandledError('composer-send', error);
          // Keep the text so the user can retry.
          setErrorNote(error instanceof Error ? error.message : 'Message failed to send');
        })
        .finally(() => setSending(false));
    },
    [sessionId],
  );

  const dictation = useDictation({
    onPartialResult: (partialText) => {
      updateText(joinDictationText(dictationBaseRef.current, partialText));
    },
    onFinalResult: (finalText) => {
      const combinedText = joinDictationText(dictationBaseRef.current, finalText);
      updateText(combinedText);
      dictationBaseRef.current = combinedText;
      if (useSettingsStore.getState().dictationMode === 'auto-send') {
        sendText(combinedText);
      } else {
        inputRef.current?.focus();
      }
    },
  });

  const onMicPress = useCallback(() => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    dictationBaseRef.current = textRef.current;
    dictation.start();
  }, [dictation]);

  const showMicButton = dictationMode !== 'off' && dictation.available;
  const sendDisabled = sending || !established || text.trim().length === 0;

  // The parent footer (SessionInputBar) owns the border and outer padding so
  // the terminal/chat input rows sit at IDENTICAL geometry - toggling the
  // lens must not shift the bottom rows by a pixel.
  return (
    <View>
      {errorNote !== null ? (
        <Text variant="caption" color="danger" style={{ paddingHorizontal: theme.spacing.xs }}>
          {errorNote}
        </Text>
      ) : null}
      <Row gap="sm" style={styles.inputRow}>
        {showMicButton ? (
          <IconButton
            iconName="mic"
            variant={dictation.listening ? 'fab' : 'raised'}
            testID={dictation.listening ? 'composer-mic-active' : 'composer-mic'}
            accessibilityLabel={dictation.listening ? 'Stop dictation' : 'Start dictation'}
            onPress={onMicPress}
          />
        ) : null}
        <TextField
          ref={inputRef}
          testID="composer-input"
          multiline
          value={text}
          onChangeText={updateText}
          placeholder="Message the agent"
          style={[styles.input, { maxHeight: COMPOSER_MAX_HEIGHT }]}
        />
        <IconButton
          iconName="send"
          variant="raised"
          testID="composer-send"
          accessibilityLabel="Send message"
          disabled={sendDisabled}
          onPress={() => sendText(textRef.current)}
        />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    // Android top-aligns multiline text; center it so the placeholder and a
    // single typed line sit mid-field like every chat composer.
    textAlignVertical: 'center',
  },
});
