import { useEffect, useRef, type RefObject } from 'react';
import type { TypingEvent } from '../../shared/typing';

interface Props {
  disabled: boolean;
  onEvent: (event: TypingEvent) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onFocusChange?: (focused: boolean) => void;
}

/**
 * Captures keystrokes as typing events. The field itself always stays empty:
 * every `beforeinput` is cancelled and translated into an event, so paste,
 * drag-and-drop, autocorrect and multi-character insertions never reach the
 * game. Only single-character inserts and backspace are accepted.
 */
export function TypingInput({ disabled, onEvent, autoFocus, placeholder, className, inputRef, onFocusChange }: Props) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const onEventRef = useRef(onEvent);
  const onFocusChangeRef = useRef(onFocusChange);
  useEffect(() => {
    onEventRef.current = onEvent;
    onFocusChangeRef.current = onFocusChange;
  });
  // Unmounting a focused input does not fire blur.
  useEffect(() => () => onFocusChangeRef.current?.(false), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleBeforeInput = (e: InputEvent) => {
      e.preventDefault();
      if (e.inputType === 'insertText' && e.data !== null && e.data.length === 1) {
        onEventRef.current({ type: 'char', char: e.data });
      } else if (e.inputType === 'deleteContentBackward') {
        onEventRef.current({ type: 'backspace' });
      }
    };
    const block = (e: Event) => e.preventDefault();
    el.addEventListener('beforeinput', handleBeforeInput);
    el.addEventListener('paste', block);
    el.addEventListener('drop', block);
    el.addEventListener('cut', block);
    return () => {
      el.removeEventListener('beforeinput', handleBeforeInput);
      el.removeEventListener('paste', block);
      el.removeEventListener('drop', block);
      el.removeEventListener('cut', block);
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled || !autoFocus) return;
    el.focus();
    // focus() on an already-focused element fires no event (e.g. StrictMode
    // remount), so report the real state.
    onFocusChangeRef.current?.(document.activeElement === el);
  }, [disabled, autoFocus, ref]);

  return (
    <input
      ref={ref}
      className={className ?? 'typing-input'}
      type="text"
      value=""
      onChange={() => {}}
      disabled={disabled}
      placeholder={placeholder}
      aria-label="Type the passage here"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      data-testid="typing-input"
    />
  );
}
