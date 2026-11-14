/**
 * The text box of a combobox whose list is drawn under it: the keyboard
 * stays in the box, and `activeId` names the option the arrows are on
 * (`aria-activedescendant`), so a screen reader follows the highlight
 * without the focus leaving the text.
 */

interface ComboboxInputProps {
  inputRef: React.Ref<HTMLInputElement>;
  className: string;
  /** What the box is for, as a screen reader says it. */
  label: string;
  /** The id of the listbox it filters. */
  listId: string;
  /** The DOM id of the highlighted option, if there is one. */
  activeId: string | undefined;
  placeholder: string;
  value: string;
  onValue: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function ComboboxInput({
  inputRef,
  className,
  label,
  listId,
  activeId,
  placeholder,
  value,
  onValue,
  onKeyDown,
}: ComboboxInputProps) {
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
      aria-activedescendant={activeId}
      placeholder={placeholder}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(event) => onValue(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
