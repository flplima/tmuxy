import { useAppSend } from '../machines/appHooks';
import { Tooltip } from './Tooltip';
import './NewTabButton.css';

export function NewTabButton() {
  const send = useAppSend();
  return (
    <Tooltip label="New tab">
      <button
        className="tab-add"
        onClick={() => send({ type: 'CREATE_TAB' })}
        aria-label="Create new tab"
      >
        +
      </button>
    </Tooltip>
  );
}
