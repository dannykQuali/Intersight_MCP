/**
 * Shifted characters must be typed with a REAL Shift keydown.
 *
 * Field repro: typing `aA!@#1-_=+` at an echoing console delivered `aa1231--==`
 * — every shifted character arrived as its unshifted base key, so passwords
 * like "Cisco123!" reached the box as "cisco1231" and logins failed.
 *
 * The vKVM client forwards keys to the BMC as USB-HID scancode + modifier
 * byte, and it builds that modifier byte by TRACKING Shift keydown/keyup
 * events. Playwright's keyboard.type('A') never sends one: it dispatches the
 * character with a modifier flag on the event, which the client does not read.
 * The fix is to type shifted characters as explicit Shift+<base-key> presses,
 * which produce the same event sequence as a human holding Shift.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pressSpecsForText, normalizeKeyCombo } from '../src/utils/keyboardText.js';

describe('pressSpecsForText', () => {
  it('turns the field-repro string into explicit Shift presses', () => {
    assert.deepEqual(pressSpecsForText('aA!@#1-_=+'), [
      'a',
      'Shift+a',
      'Shift+1',
      'Shift+2',
      'Shift+3',
      '1',
      '-',
      'Shift+-',
      '=',
      'Shift+=',
    ]);
  });

  it('types the password that actually failed', () => {
    assert.deepEqual(pressSpecsForText('Cisco123!'), [
      'Shift+c',
      'i',
      's',
      'c',
      'o',
      '1',
      '2',
      '3',
      'Shift+1',
    ]);
  });

  it('covers the whole shifted symbol row', () => {
    assert.deepEqual(pressSpecsForText('~!@#$%^&*()_+{}|:"<>?'), [
      'Shift+`',
      'Shift+1',
      'Shift+2',
      'Shift+3',
      'Shift+4',
      'Shift+5',
      'Shift+6',
      'Shift+7',
      'Shift+8',
      'Shift+9',
      'Shift+0',
      'Shift+-',
      'Shift+=',
      'Shift+[',
      'Shift+]',
      'Shift+\\',
      'Shift+;',
      "Shift+'",
      'Shift+,',
      'Shift+.',
      'Shift+/',
    ]);
  });

  it('passes unshifted characters through untouched', () => {
    assert.deepEqual(pressSpecsForText("abc019`-=[]\\;',./ "), [
      'a',
      'b',
      'c',
      '0',
      '1',
      '9',
      '`',
      '-',
      '=',
      '[',
      ']',
      '\\',
      ';',
      "'",
      ',',
      '.',
      '/',
      ' ',
    ]);
  });

  it('maps control whitespace to named keys', () => {
    assert.deepEqual(pressSpecsForText('a\nb\tc'), ['a', 'Enter', 'b', 'Tab', 'c']);
    // A CRLF is one line ending, not two Enters.
    assert.deepEqual(pressSpecsForText('a\r\nb'), ['a', 'Enter', 'b']);
    assert.deepEqual(pressSpecsForText('a\rb'), ['a', 'Enter', 'b']);
  });

  it('refuses characters that cannot be produced as US-layout keystrokes', () => {
    // A BMC receives scancodes, not text: there is no keystroke for "é". Better
    // to fail loudly than to silently deliver a mangled password.
    assert.throws(() => pressSpecsForText('café'), /cannot be typed|no US-layout/i);
  });
});

describe('normalizeKeyCombo', () => {
  it('rewrites an uppercase letter in a combo to Shift+lowercase', () => {
    // ["Shift+C","Shift+1"] was reported to deliver NOTHING; a bare uppercase
    // letter under an explicitly held Shift confuses the layout lookup.
    assert.equal(normalizeKeyCombo('Shift+C'), 'Shift+c');
    assert.equal(normalizeKeyCombo('C'), 'Shift+c');
  });

  it('rewrites a shifted symbol to Shift+base', () => {
    assert.equal(normalizeKeyCombo('!'), 'Shift+1');
    assert.equal(normalizeKeyCombo('Shift+!'), 'Shift+1');
    assert.equal(normalizeKeyCombo('Control+!'), 'Control+Shift+1');
  });

  it('never duplicates a Shift already present', () => {
    assert.equal(normalizeKeyCombo('Shift+A'), 'Shift+a');
  });

  it('leaves named keys and ordinary combos alone', () => {
    for (const combo of ['Enter', 'F2', 'Escape', 'Control+Alt+Delete', 'Shift', 'Shift+F10', 'a', '1', 'Control+c']) {
      assert.equal(normalizeKeyCombo(combo), combo);
    }
  });
});
