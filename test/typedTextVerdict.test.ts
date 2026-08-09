/**
 * Did the text we typed actually land on the console, and if not, was it eaten by
 * HID auto-repeat?
 *
 * Field report, with a screenshot: an agent typed
 * `grep -m3 -riE "nocloud|autoinstall|ds" /var/log/cloud-init.log` and the
 * console showed `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll`. The recorder's own
 * transcript held 62 such lines, with runs of 20 to 50 identical characters —
 * a key held for one to two seconds while the client's HID queue stalled, so the
 * guest's keyboard auto-repeat filled the gap.
 *
 * "It did not match" is not a useful verdict for that. The specific claim
 * "your text arrived with repeat damage on these characters" is, because it
 * tells the caller the text was delivered and the CADENCE was wrong — a
 * different remedy from "nothing arrived at all", which means focus or a dead
 * input channel.
 *
 * The squeeze test is what separates them: collapsing runs of three or more in
 * BOTH strings makes a mangled line comparable to its intended form, while
 * leaving legitimate doubles ("install", "ll") and intended runs ("-----")
 * alone.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { verifyTypedText } from '../src/utils/typedTextVerdict.js';

/** The line from the field screenshot, as OCR read it off the console. */
const MANGLED =
  'grep -m3 -riE "nocloud|autoiiiiiiiiiiiiiiiiiiiiinstaaaaaaaaaaaaaaaaaaaaall|dsssssssssssssssssssssssssss" ' +
  '/vaaaaaaaaaaaaaaaaaaaaar/looooooooooooooooooog/clooooooooooooooooooooud-init.llllllllllllllllllog';
const INTENDED = 'grep -m3 -riE "nocloud|autoinstall|ds" /var/log/cloud-init.log';

describe('verifying text typed into a console', () => {
  it('accepts a clean echo', () => {
    const v = verifyTypedText('cat /proc/cmdline', 'root@ubuntu-server:/# cat /proc/cmdline');
    assert.equal(v.matched, true);
    assert.deepEqual(v.repeatDamage, []);
  });

  it('names repeat damage instead of just reporting a mismatch', () => {
    const v = verifyTypedText(INTENDED, `root@ubuntu-server:/# ${MANGLED}`);
    assert.equal(v.matched, false);
    assert.match(v.reason, /repeat/i);
    const chars = v.repeatDamage.map((d) => d.char);
    for (const expected of ['i', 'a', 's', 'o', 'l']) {
      assert.ok(chars.includes(expected), `expected the stuck '${expected}' to be reported, got ${chars.join('')}`);
    }
    assert.ok(
      v.repeatDamage.some((d) => d.count >= 20),
      `the worst run should be reported at its real length, saw ${JSON.stringify(v.repeatDamage)}`
    );
  });

  it('says nothing landed when the text is absent, and claims no damage', () => {
    // Different remedy entirely: focus, or a dead input channel.
    const v = verifyTypedText('systemctl status cloud-init', 'root@ubuntu-server:/# ');
    assert.equal(v.matched, false);
    assert.deepEqual(v.repeatDamage, []);
    assert.match(v.reason, /not (found|on screen)|nothing/i);
  });

  it('does not mistake legitimate double letters for damage', () => {
    const v = verifyTypedText('install all files', 'root@x:~# install all files');
    assert.equal(v.matched, true);
    assert.deepEqual(v.repeatDamage, []);
  });

  it('does not mistake a run the caller typed on purpose for damage', () => {
    const text = 'echo -----BEGIN----- && sleep 1000';
    const v = verifyTypedText(text, `root@x:~# ${text}`);
    assert.equal(v.matched, true);
    assert.deepEqual(v.repeatDamage, []);
  });

  it('tolerates the whitespace and case noise OCR introduces', () => {
    // OCR collapses runs of spaces and gets case wrong on console fonts; neither
    // is evidence that the keystrokes were wrong.
    const v = verifyTypedText('ls -la /etc/netplan', 'ROOT@x:~#   LS -LA  /ETC/NETPLAN ');
    assert.equal(v.matched, true);
  });

  it('reports damage even when the tail of the line is missing', () => {
    // A stuck key can push the rest of the command off the visible line, so the
    // verdict must not depend on seeing all of it.
    const v = verifyTypedText('grep -riE nocloud /var/log/cloud-init.log', 'grep -riE nocloooooooooooud /var/lo');
    assert.equal(v.matched, false);
    assert.ok(v.repeatDamage.some((d) => d.char === 'o' && d.count >= 4));
  });

  it('treats an empty observation as nothing landed, not as a match', () => {
    const v = verifyTypedText('reboot', '');
    assert.equal(v.matched, false);
    assert.deepEqual(v.repeatDamage, []);
  });

  it('matches text the caller typed with no letters at all', () => {
    const v = verifyTypedText('^C', 'root@x:~# ^C');
    assert.equal(v.matched, true);
  });
});
