import { useRef, useEffect } from 'react';

/**
 * Custom hook to track the previous value of a state or prop.
 * Useful for detecting changes and triggering animations based on state transitions.
 *
 * Reference: https://medium.com/@sergeyleschev/react-custom-hook-useprevious-bc1cdc6dbf4e
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}
