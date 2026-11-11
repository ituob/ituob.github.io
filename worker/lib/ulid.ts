const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID (48-bit ms time + 80 random bits, Crockford base32). `t` is injectable for tests. */
export function ulid(t: number = Date.now()): string {
  let time = "";
  for (let i = 0, n = t; i < 10; i++, n = Math.floor(n / 32)) time = ALPHABET[n % 32] + time;
  const r = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[r[i]! % 32];
  return time + rand;
}
