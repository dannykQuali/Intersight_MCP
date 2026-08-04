/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Text -> key presses that survive the trip to a BMC.
 *
 * A vKVM console is not a text box. The client forwards input to the BMC as
 * USB-HID scancode + modifier byte, and it derives the modifier byte by
 * TRACKING physical Shift keydown/keyup events. Playwright's keyboard.type()
 * never produces one: it dispatches each character with a modifier FLAG on the
 * event, which the client does not read. The observed result (field repro):
 * typing `aA!@#1-_=+` delivered `aa1231--==` — every shifted character arrived
 * as its unshifted base key, so "Cisco123!" reached a login prompt as
 * "cisco1231".
 *
 * The fix is to type each shifted character as an explicit `Shift+<base>`
 * press, which emits the same event sequence as a human holding Shift: Shift
 * keydown, base-key keydown/keyup, Shift keyup.
 */

/** US-layout shifted character -> the base key that produces it with Shift. */
const SHIFTED_TO_BASE: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

/** Characters that are a key of their own on the US layout, pressed bare. */
const UNSHIFTED = new Set("abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./ ".split(''));

/**
 * The press sequence (Playwright `keyboard.press` specs) that types `text` on
 * a US-layout console. Throws on characters that no US keystroke can produce —
 * a BMC receives scancodes, so silently dropping or mangling them (say, in a
 * password) is worse than refusing.
 */
export function pressSpecsForText(text: string): string[] {
  const specs: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      // A lone CR is a line ending; CRLF is ONE line ending.
      if (text[i + 1] === '\n') {
        i++;
      }
      specs.push('Enter');
      continue;
    }
    if (ch === '\n') {
      specs.push('Enter');
      continue;
    }
    if (ch === '\t') {
      specs.push('Tab');
      continue;
    }
    if (UNSHIFTED.has(ch)) {
      specs.push(ch);
      continue;
    }
    if (ch >= 'A' && ch <= 'Z') {
      specs.push(`Shift+${ch.toLowerCase()}`);
      continue;
    }
    const base = SHIFTED_TO_BASE[ch];
    if (base !== undefined) {
      specs.push(`Shift+${base}`);
      continue;
    }
    throw new Error(
      `Character ${JSON.stringify(ch)} cannot be typed into a console: no US-layout keystroke produces it. ` +
        `The console receives keystrokes (scancodes), not text.`
    );
  }
  return specs;
}

/**
 * Normalise a key combo so its final key is a BASE key.
 *
 * `["Shift+C","Shift+1"]` was reported to deliver nothing at all: an uppercase
 * letter (itself a shifted character) named under an explicitly held Shift
 * confuses the layout lookup. Rewriting to `Shift+c` makes the combo mean what
 * the caller meant. Named keys (`Enter`, `F2`, `Delete`) and already-base
 * combos pass through untouched.
 */
export function normalizeKeyCombo(combo: string): string {
  // A bare '+' is the key itself, not a separator.
  if (combo === '+') {
    return 'Shift+=';
  }
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  if (key.length !== 1) {
    return combo; // named key: Enter, F2, Delete, Shift, ...
  }
  const modifiers = parts.slice(0, -1);
  const rebuild = (baseKey: string, needsShift: boolean): string => {
    const mods = [...modifiers];
    if (needsShift && !mods.includes('Shift')) {
      mods.push('Shift');
    }
    // Keep modifier order stable and conventional: Control, Alt, Meta, Shift.
    const order = ['Control', 'Alt', 'Meta', 'Shift'];
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...mods, baseKey].join('+');
  };
  if (key >= 'A' && key <= 'Z') {
    return rebuild(key.toLowerCase(), true);
  }
  const base = SHIFTED_TO_BASE[key];
  if (base !== undefined) {
    return rebuild(base, true);
  }
  return combo;
}
