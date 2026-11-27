/**
 * Lets pending promise chains finish (e.g. an interceptor awaiting a token,
 * then the component reacting to the response). A macrotask tick, not a
 * zone helper: the app is zoneless.
 */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve));
