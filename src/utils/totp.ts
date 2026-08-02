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

import crypto from 'crypto';

export interface TotpParams {
  /** Shared secret, base32 (as used by authenticator apps / otpauth URIs). */
  secret: string;
  digits: number;
  periodSeconds: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  /** Informational only (from an otpauth URI). Never logged with the secret. */
  issuer?: string;
  label?: string;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode a base32 (RFC 4648) string, tolerating lowercase, spaces and padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) {
    throw new Error('TOTP secret is empty');
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`TOTP secret is not valid base32 (unexpected character '${char}')`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * Parse an `otpauth://totp/...` URI (what an authenticator app is given) into
 * TOTP parameters. Also accepts a bare base32 secret for convenience.
 */
export function parseTotpConfig(uriOrSecret: string): TotpParams {
  const raw = (uriOrSecret ?? '').trim();
  if (!raw) {
    throw new Error('No TOTP secret or otpauth:// URI provided');
  }
  const defaults = { digits: 6, periodSeconds: 30, algorithm: 'sha1' as const };

  if (!/^otpauth:\/\//i.test(raw)) {
    // Treat as a bare base32 secret; validate it decodes.
    base32Decode(raw);
    return { secret: raw, ...defaults };
  }

  // URL can't always parse otpauth:// reliably across runtimes; normalize to https for parsing.
  const parsed = new URL(raw.replace(/^otpauth:\/\//i, 'https://'));
  const params = parsed.searchParams;
  const secret = params.get('secret');
  if (!secret) {
    throw new Error('otpauth URI is missing the required "secret" parameter');
  }
  base32Decode(secret);

  const algoRaw = (params.get('algorithm') ?? 'SHA1').toLowerCase();
  const algorithm = algoRaw === 'sha256' ? 'sha256' : algoRaw === 'sha512' ? 'sha512' : 'sha1';
  const digits = Number(params.get('digits')) || defaults.digits;
  const periodSeconds = Number(params.get('period')) || defaults.periodSeconds;

  return {
    secret,
    digits,
    periodSeconds,
    algorithm,
    issuer: params.get('issuer') ?? undefined,
    label: decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || undefined,
  };
}

/** Generate a TOTP code (RFC 6238) for a given time (defaults to now). */
export function generateTotp(params: TotpParams, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / params.periodSeconds);
  const counterBuf = Buffer.alloc(8);
  // 64-bit big-endian counter
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac(params.algorithm, base32Decode(params.secret)).update(counterBuf).digest();
  // Dynamic truncation (RFC 4226 §5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** params.digits;
  return code.toString().padStart(params.digits, '0');
}

/** Milliseconds until the current TOTP window ends (useful to avoid reusing a code). */
export function msUntilNextWindow(params: TotpParams, atMs: number = Date.now()): number {
  const periodMs = params.periodSeconds * 1000;
  return periodMs - (atMs % periodMs);
}

/**
 * Seconds remaining in the current window. When a login form rejects a code as
 * already-used, wait for the next window before retrying.
 */
export function secondsRemainingInWindow(params: TotpParams, atMs: number = Date.now()): number {
  return Math.ceil(msUntilNextWindow(params, atMs) / 1000);
}
