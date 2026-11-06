/**
 * Selectors memoized on the inputs `inputSelector` names, compared shallowly:
 * the machine's context is a new object on every update, so the context itself
 * cannot be the key.
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

    if (hasCache && shallowEqual(lastInput, currentInput)) {
      return lastResult as TResult;
    }

    const result = resultSelector(context);
    lastInput = currentInput;
    lastResult = result;
    hasCache = true;

    return result;
  };
}

/** One cache per argument value (a pane id, say); past `maxCacheSize` the oldest goes. */
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

function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

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
