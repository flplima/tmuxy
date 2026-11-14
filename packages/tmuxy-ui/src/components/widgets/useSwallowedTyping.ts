import { useEffect, useRef } from 'react';
import { useBindingOwnsKey } from '../../machines/appHooks';
import { isRealFormControl } from '../../machines/actors/keyboard/keyFormatting';

/**
 * A plain key typed at a widget is nobody's: the pane runs no program that
 * reads it, and sent there it would echo under the widget marker. So a key with
 * no modifier stops here, unless a binding owns it (the `-` of `prefix -`); a
 * chord goes on to the app (the prefix, Ctrl+hjkl, and Ctrl+C, which
 * `WidgetPane` turns into the widget's exit). The document's capture phase runs
 * after every window capture listener (the pager's among them) and before the
 * keyboard actor's, which listens on the window as the event bubbles back.
 */
export function useSwallowedTyping(active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const bindingOwnsKey = useBindingOwnsKey();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || e.ctrlKey || e.altKey || e.metaKey) return;
      // A text box of the widget's own (a comment) takes its keys.
      if (isRealFormControl(e.target)) return;
      if (bindingOwnsKey(e.key)) return;
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [bindingOwnsKey]);
}
