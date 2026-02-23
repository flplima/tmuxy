/**
 * Simple memoization utilities for selectors
 *
 * Uses reference equality checking on inputs to avoid recomputation.
 * Designed for use with XState selectors where context objects change on every update.
 */

/**
 * Memoize a selector function based on relevant input properties.
 *
 * The inputSelector extracts the relevant pieces from the context that affect the output.
 * If these pieces haven't changed (shallow equality), the cached result is returned.
 *
 * @param inputSelector - Function that extracts relevant inputs from the context
 * @param resultSelector - Function that computes the result from the context
 * @returns Memoized selector function
 */
export function createMemoizedSelector<TContext, TInput, TResult>(
  inputSelector: (context: TContext) => TInput,
  resultSelector: (context: TContext) => TResult,
): (context: TContext) => TResult {
  let lastInput: TInput | undefined;
  let lastResult: TResult | undefined;
  let hasCache = false;

  return (context: TContext): TResult => {
    const currentInput = inputSelector(context);

    // Check if inputs are the same (shallow equality for objects/arrays)
    if (hasCache && shallowEqual(lastInput, currentInput)) {
      return lastResult as TResult;
    }

    // Compute new result
    const result = resultSelector(context);
    lastInput = currentInput;
    lastResult = result;
    hasCache = true;

    return result;
  };
}

/**
 * Memoize a selector that takes an additional argument (e.g., paneId).
 * Creates a cache per argument value.
 */
export function createMemoizedSelectorWithArg<TContext, TArg, TInput, TResult>(
  inputSelector: (context: TContext, arg: TArg) => TInput,
  resultSelector: (context: TContext, arg: TArg) => TResult,
  maxCacheSize: number = 50,
): (context: TContext, arg: TArg) => TResult {
  const cache = new Map<TArg, { lastInput: TInput; lastResult: TResult }>();

  return (context: TContext, arg: TArg): TResult => {
    const currentInput = inputSelector(context, arg);
    const cached = cache.get(arg);

    if (cached && shallowEqual(cached.lastInput, currentInput)) {
      return cached.lastResult;
    }

    const result = resultSelector(context, arg);

    // LRU eviction
    if (cache.size >= maxCacheSize && !cache.has(arg)) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }

    cache.set(arg, { lastInput: currentInput, lastResult: result });
    return result;
  };
}

/**
 * Shallow equality check for memoization inputs.
 * Handles primitives, arrays, and plain objects.
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Plain objects
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keysA = Object.keys(aObj);
    const keysB = Object.keys(bObj);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (aObj[key] !== bObj[key]) return false;
    }
    return true;
  }

  return false;
}
