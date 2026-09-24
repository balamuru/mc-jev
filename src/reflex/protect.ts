/**
 * Players the bot must never attack: its owner, its configured allies, and the other bots it runs
 * with. This is a hard safety rule enforced in code, however a player got marked as hostile.
 */
export function isProtectedPlayer(
  name: string,
  protectedNames: readonly string[] | undefined,
): boolean {
  if (!protectedNames?.length) return false;
  const wanted = name.toLowerCase();
  return protectedNames.some((p) => p.toLowerCase() === wanted);
}
