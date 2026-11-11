/**
 * The text box of a filtered list, as a combobox: the keyboard stays in the
 * box, where typing has to go, and the arrows move a highlight through the
 * list instead of the focus (`aria-activedescendant`). The session picker and
 * the activity inbox are both one of these over a listbox.
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';

interface FilterBoxProps {
  className: string;
  /** What the box filters, for a screen reader: "Filter sessions". */
  label: string;
  /** The listbox it controls, and the option the arrows have reached in it. */
  listId: string;
  activeOptionId: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** Takes the focus when it mounts, without scrolling anything to do it. */
export function FilterBox({
  className,
  label,
  listId,
  activeOptionId,
  value,
  onChange,
  onKeyDown,
}: FilterBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  return (
    <input
      ref={inputRef}
      className={className}
      type="text"
      role="combobox"
      aria-label={label}
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={activeOptionId}
      placeholder={`${label}…`}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
