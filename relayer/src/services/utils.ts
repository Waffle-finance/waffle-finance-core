/** Returns the current unix timestamp in seconds. */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
