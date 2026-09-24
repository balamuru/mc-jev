export type CommandName = 'follow' | 'guard' | 'hunt' | 'stop' | 'status' | 'auto' | 'help';

export interface Command {
  name: CommandName;
  /** True when the message named this bot, e.g. "JevBot follow". */
  addressed: boolean;
}

const COMMANDS: Array<[RegExp, CommandName]> = [
  [/^follow( me)?$/, 'follow'],
  [/^guard( here)?$/, 'guard'],
  [/^hunt$/, 'hunt'],
  [/^stop$/, 'stop'],
  [/^status$/, 'status'],
  [/^auto$/, 'auto'],
  [/^help$/, 'help'],
];

/** Everything the owner can say, for the help reply and the docs. */
export const HELP_TEXT =
  'commands: follow, guard here, hunt, stop, status, auto, help. ' +
  'Put my name first to command only me.';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read a chat message as a command. Commands are matched exactly (case-insensitive, with an
 * optional leading "!"), so ordinary conversation is never mistaken for one. A message may start
 * with the bot's name (`JevBot follow`, `@JevBot: stop`) to address only that bot.
 */
export function parseChat(message: string, botName: string): Command | null {
  let text = message.trim().toLowerCase();
  let addressed = false;
  const address = new RegExp(`^@?${escapeRegExp(botName.toLowerCase())}\\s*[:,]?\\s+`);
  const match = address.exec(text);
  if (match) {
    text = text.slice(match[0].length);
    addressed = true;
  }
  text = text.replace(/^!/, '').trim();
  for (const [pattern, name] of COMMANDS) {
    if (pattern.test(text)) return { name, addressed };
  }
  return null;
}

/** Only the bot's owner may command it, and a bot with no owner obeys nobody. Names are case-insensitive. */
export function isAuthorized(sender: string, owner: string | undefined): boolean {
  return !!owner && sender.toLowerCase() === owner.toLowerCase();
}
