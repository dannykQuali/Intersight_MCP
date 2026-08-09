/**
 * The retry policy behind vkvm_paste_text, tested as policy.
 *
 * This is where the field bug is actually answered. An agent typed a command, the
 * guest's key-repeat mangled it into `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll`, and
 * Enter was pressed on the result. So: every retry must type SLOWER (the previous
 * cadence has just been disproved), must CLEAR the line first (or it appends to
 * the damage), and the caller must learn whether the line was ever verified —
 * because that is the only safe basis for pressing Enter.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { runPasteAttempts, delayForAttempt, PASTE_CHAR_DELAY_MS } from '../src/utils/pacedTyping.js';
import { verifyTypedText } from '../src/utils/typedTextVerdict.js';

/** A console that echoes cleanly only once the cadence is slow enough. */
function fakeConsole(opts: { cleanFromDelayMs: number }) {
  const log: string[] = [];
  let screen = '';
  return {
    log,
    io: {
      type: async (text: string, charDelayMs: number) => {
        log.push(`type@${charDelayMs}`);
        // Below the threshold a key sticks, exactly as the HID queue stall does.
        screen += charDelayMs >= opts.cleanFromDelayMs ? text : text.replace(/o/g, 'o'.repeat(22));
        return { presses: text.length };
      },
      read: async () => {
        log.push('read');
        return `root@host:~# ${screen}`;
      },
      check: verifyTypedText,
      clear: async () => {
        log.push('clear');
        screen = '';
      },
    },
  };
}

describe('paste retry policy', () => {
  it('stops after the first attempt when the line is clean', async () => {
    const c = fakeConsole({ cleanFromDelayMs: 0 });
    const r = await runPasteAttempts({
      text: 'reboot now',
      maxAttempts: 3,
      // Pinned, so this tests the ladder rather than whatever the default is.
      baseDelayMs: 60,
      verify: true,
      ...c.io,
    });
    assert.equal(r.verified, true);
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(c.log, ['type@60', 'read'], 'no clear, no second attempt');
  });

  it('clears the line before retyping, so damage does not accumulate', async () => {
    const c = fakeConsole({ cleanFromDelayMs: 105 });
    const r = await runPasteAttempts({
      text: 'cloud-init status',
      maxAttempts: 3,
      baseDelayMs: 60,
      verify: true,
      ...c.io,
    });
    assert.equal(r.verified, true, 'the slower retry should have landed');
    assert.deepEqual(c.log, ['type@60', 'read', 'clear', 'type@105', 'read']);
  });

  it('types slower on every retry', async () => {
    const c = fakeConsole({ cleanFromDelayMs: 99999 }); // never clean
    await runPasteAttempts({
      text: 'nocloud',
      maxAttempts: 4,
      baseDelayMs: PASTE_CHAR_DELAY_MS,
      verify: true,
      ...c.io,
    });
    const cadences = c.log.filter((l) => l.startsWith('type@')).map((l) => Number(l.slice(5)));
    assert.equal(cadences.length, 4);
    for (let i = 1; i < cadences.length; i++) {
      assert.ok(cadences[i] > cadences[i - 1], `attempt ${i + 1} must be slower: ${cadences.join(' -> ')}`);
    }
    assert.equal(cadences[0], delayForAttempt(1, PASTE_CHAR_DELAY_MS));
  });

  it('reports failure with the damage named, never a bare false', async () => {
    const c = fakeConsole({ cleanFromDelayMs: 99999 });
    const r = await runPasteAttempts({
      text: 'nocloud',
      maxAttempts: 2,
      baseDelayMs: PASTE_CHAR_DELAY_MS,
      verify: true,
      ...c.io,
    });
    assert.equal(r.verified, false);
    assert.match(String(r.problem), /repeat/i);
    assert.ok(
      r.attempts.every((a) => a.matched === false),
      'each attempt must record its own outcome'
    );
    assert.ok(r.attempts.some((a) => (a.repeatDamage ?? []).some((d) => d.char === 'o' && d.count >= 20)));
  });

  it('honours maxAttempts exactly', async () => {
    const c = fakeConsole({ cleanFromDelayMs: 99999 });
    const r = await runPasteAttempts({
      text: 'nocloud',
      maxAttempts: 1,
      baseDelayMs: PASTE_CHAR_DELAY_MS,
      verify: true,
      ...c.io,
    });
    assert.equal(r.attempts.length, 1, 'one attempt means one attempt, even on failure');
  });

  it('types once and claims nothing when verification is off', async () => {
    // Blind typing must report verified: null — not true. "I did not check" and
    // "I checked and it was fine" are different answers.
    const c = fakeConsole({ cleanFromDelayMs: 99999 });
    const r = await runPasteAttempts({
      text: 'nocloud',
      maxAttempts: 3,
      baseDelayMs: 60,
      verify: false,
      ...c.io,
    });
    assert.equal(r.verified, null);
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(c.log, ['type@60'], 'nothing is read when nothing is verified');
  });

  it('skips clearing when the target has no line editor', async () => {
    // A BIOS field has no Control+u; clearing it would send a stray keystroke.
    const c = fakeConsole({ cleanFromDelayMs: 99999 });
    const { clear, ...noClear } = c.io;
    await runPasteAttempts({
      text: 'nocloud',
      maxAttempts: 2,
      baseDelayMs: PASTE_CHAR_DELAY_MS,
      verify: true,
      ...noClear,
    });
    assert.equal(c.log.filter((l) => l === 'clear').length, 0);
    assert.equal(c.log.filter((l) => l.startsWith('type@')).length, 2, 'but it still retries');
  });

  it('treats an unreadable console as unverified rather than as a match', async () => {
    const log: string[] = [];
    const r = await runPasteAttempts({
      text: 'ls',
      maxAttempts: 1,
      baseDelayMs: PASTE_CHAR_DELAY_MS,
      verify: true,
      type: async () => {
        log.push('type');
        return { presses: 2 };
      },
      read: async () => null, // OCR unavailable
      check: verifyTypedText,
    });
    assert.equal(r.verified, false);
    assert.match(String(r.problem), /nothing|not/i);
  });
});
