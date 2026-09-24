import { describe, expect, it } from 'vitest';
import { HELP_TEXT, isAuthorized, parseChat } from '../src/control/commands.js';

describe('parseChat', () => {
  it.each([
    ['follow', 'follow'],
    ['follow me', 'follow'],
    ['guard', 'guard'],
    ['guard here', 'guard'],
    ['hunt', 'hunt'],
    ['stop', 'stop'],
    ['status', 'status'],
    ['auto', 'auto'],
    ['help', 'help'],
  ])('reads "%s" as %s', (text, name) => {
    expect(parseChat(text, 'JevBot')).toEqual({ name, addressed: false });
  });

  it('ignores case, surrounding spaces and a leading bang', () => {
    expect(parseChat('  FOLLOW ME  ', 'JevBot')?.name).toBe('follow');
    expect(parseChat('!stop', 'JevBot')?.name).toBe('stop');
    expect(parseChat('! Guard Here', 'JevBot')?.name).toBe('guard');
  });

  it('notices when the message names this bot', () => {
    expect(parseChat('JevBot follow', 'JevBot')).toEqual({ name: 'follow', addressed: true });
    expect(parseChat('jevbot, stop', 'JevBot')).toEqual({ name: 'stop', addressed: true });
    expect(parseChat('@JevBot: guard here', 'JevBot')).toEqual({ name: 'guard', addressed: true });
    expect(parseChat('@JevBot !hunt', 'JevBot')).toEqual({ name: 'hunt', addressed: true });
  });

  it('does not mistake other bots’ names or ordinary chat for commands', () => {
    expect(parseChat('OtherBot follow', 'JevBot')).toBeNull();
    expect(parseChat('please follow me around', 'JevBot')).toBeNull();
    expect(parseChat('stop that', 'JevBot')).toBeNull();
    expect(parseChat('the status is unclear', 'JevBot')).toBeNull();
    expect(parseChat('hello JevBot', 'JevBot')).toBeNull();
    expect(parseChat('', 'JevBot')).toBeNull();
    expect(parseChat('JevBot', 'JevBot')).toBeNull();
  });

  it('copes with bot names that contain regex characters', () => {
    expect(parseChat('a.b follow', 'a.b')?.name).toBe('follow');
    expect(parseChat('axb follow', 'a.b')).toBeNull();
  });
});

describe('isAuthorized', () => {
  it('accepts only the owner, ignoring case', () => {
    expect(isAuthorized('Steve', 'Steve')).toBe(true);
    expect(isAuthorized('steve', 'STEVE')).toBe(true);
    expect(isAuthorized('Alex', 'Steve')).toBe(false);
  });

  it('obeys nobody when there is no owner', () => {
    expect(isAuthorized('Steve', undefined)).toBe(false);
    expect(isAuthorized('', '')).toBe(false);
  });
});

describe('HELP_TEXT', () => {
  it('lists every command', () => {
    for (const word of ['follow', 'guard', 'hunt', 'stop', 'status', 'auto']) {
      expect(HELP_TEXT).toContain(word);
    }
  });
});
