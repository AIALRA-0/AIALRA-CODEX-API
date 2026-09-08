export async function readVisibleResource<T>(
  load: () => Promise<T>,
  signal: AbortSignal | undefined,
  onValue: (value: T) => void,
  onError: (cause: unknown) => void,
) {
  try {
    const value = await load();
    if (!signal?.aborted) onValue(value);
  } catch (cause) {
    if (!signal?.aborted) onError(cause);
  }
}
