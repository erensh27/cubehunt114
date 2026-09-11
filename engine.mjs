/* Exact bounded kernel for x^3 + y^3 + z^3 = 114.
 * Uses BigInt arithmetic and WebCrypto SHA-256 for deterministic results.
 * Bit-for-bit identical to tools/search_core.py.
 */

export const ENGINE = '114-engine-v1';
export const BLOCK_SIZE = 16;
export const ROWS_PER_TASK = 128;
const SCALE = 10n ** 18n;
const ALPHA = 4848807585839879338n;
const ALPHA2 = 23510935004498358840n;
export const D0 = 10n ** 19n / 54n;
export const PRIMES = Object.freeze([5, 7, 11, 13, 17, 19, 23, 31, 37, 41, 43, 47, 53, 59, 61]);
const SHAPES = [[6000000, 8, 31], [1500000, 128, 511], [375000, 2048, 8191]];
const BANDS = [[0, 64], [64, 256], [256, 4096]];

const contexts = [];
for (const ell of [1, 5, 25]) {
  for (let shape = 0; shape < SHAPES.length; shape++) {
    const [radius, tlo, thi] = SHAPES[shape];
    for (let shell = 0; shell < 3; shell++) {
      for (let band = 0; band < BANDS.length; band++) {
        const [low, high] = BANDS[band];
        contexts.push(Object.freeze({
          id: `c${String(contexts.length).padStart(2, '0')}`,
          ell,
          shape,
          shell,
          band,
          radius,
          tlo,
          thi,
          dlo: String(D0 * 2n ** BigInt(shell)),
          dhi: String(D0 * 2n ** BigInt(shell + 1)),
          low,
          high,
          totalRows: String(BigInt(2 * radius + 1) ** 2n),
          rowStride: ROWS_PER_TASK,
          rowTasks: String((BigInt(2 * radius + 1) ** 2n + BigInt(ROWS_PER_TASK) - 1n) / BigInt(ROWS_PER_TASK)),
          blocks: Math.floor((thi - tlo + BLOCK_SIZE) / BLOCK_SIZE),
        }));
      }
    }
  }
}

export const CONTEXTS = Object.freeze(contexts);
const byId = new Map(CONTEXTS.map(c => [c.id, c]));

const counterKeys = [
  'generators', 'outside_shell', 'invalid_d', 'signed_excluded', 'noninvertible',
  'curves', 'quotient_points', 'rejected_mod243', 'rejected_parity', 'rejected_prime',
  'exact_tests', 'hits'
];

export const emptyCounters = () => Object.fromEntries(counterKeys.map(k => [k, 0]));

const mod = (a, b) => {
  const r = a % b;
  return r < 0n ? r + b : r;
};

const modNumber = (a, b) => ((a % b) + b) % b;
const floorDiv = (a, b) => a / b - (a % b < 0n ? 1n : 0n);
const abs = a => a < 0n ? -a : a;

const gcd = (a, b) => {
  a = abs(a);
  while (b) [a, b] = [b, a % b];
  return a;
};

function inverse(a, m) {
  let [t, nt, r, nr] = [0n, 1n, m, mod(a, m)];
  while (nr) {
    const q = r / nr;
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  if (r !== 1n) throw new RangeError('noninvertible value');
  return mod(t, m);
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      Object.keys(task).sort().join(',') !== 'block,context,engine,row,version') {
    throw new TypeError('unexpected or missing task fields');
  }
  if (task.version !== 1 || task.engine !== ENGINE) throw new RangeError('unsupported engine/version');
  const c = byId.get(task.context);
  if (!c) throw new RangeError('unknown fixed context');
  if (typeof task.row !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(task.row) ||
      BigInt(task.row) >= BigInt(c.totalRows) || BigInt(task.row) % BigInt(ROWS_PER_TASK)) {
    throw new RangeError('row outside context or not aligned to rowStride');
  }
  if (!Number.isInteger(task.block) || task.block < 0 || task.block >= c.blocks) {
    throw new RangeError('block outside context');
  }
  return { version: 1, engine: ENGINE, context: task.context, row: task.row, block: task.block };
}

export function makeTask(context, row, block = 0) {
  if (typeof row === 'number' && !Number.isSafeInteger(row)) throw new TypeError('row number must be a safe integer');
  return validateTask({ version: 1, engine: ENGINE, context, row: String(row), block });
}

export function taskId(task) {
  const t = validateTask(task);
  return `${ENGINE}:${t.context}:${t.row}:${t.block}`;
}

export function isqrt(n) {
  if (typeof n !== 'bigint' || n < 0n) throw new RangeError('isqrt needs a nonnegative BigInt');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

export function verifyTriple(xyz, k = 114) {
  if (!Array.isArray(xyz) || xyz.length !== 3 || !Number.isSafeInteger(k) ||
      xyz.some(v => typeof v !== 'string' || !/^-?(0|[1-9][0-9]{0,127})$/.test(v) || v === '-0')) {
    return false;
  }
  return xyz.reduce((s, v) => s + BigInt(v) ** 3n, 0n) === BigInt(k);
}

export function offsetBase(ell, b, c) {
  ell = BigInt(ell); b = BigInt(b); c = BigInt(c);
  const residue = mod(-4n * b - 16n * c, ell);
  const numerator = -ALPHA * b - ALPHA2 * c - residue * SCALE;
  const denominator = ell * SCALE;
  return residue + ell * floorDiv(2n * numerator + denominator, 2n * denominator);
}

export function norm(a, b, c, k = 114n) {
  k = BigInt(k);
  return a ** 3n + k * b ** 3n + k * k * c ** 3n - 3n * k * a * b * c;
}

const filterCache = new Map();
function filters(k) {
  if (filterCache.has(k)) return filterCache.get(k);
  const cubes = Array.from({ length: 243 }, (_, v) => v ** 3 % 243);
  const pairs = Array.from({ length: 243 }, () => new Uint8Array(243));
  for (let x = 0; x < 243; x++) {
    for (let y = 0; y < 243; y++) {
      pairs[(x + y) % 243][(cubes[x] + cubes[y]) % 243] = 1;
    }
  }
  const allowed = Array.from({ length: 243 }, (_, s) =>
    cubes.flatMap((cube, z) => (pairs[s][modNumber(k - cube, 243)] ? [z] : []))
  );
  const masks = PRIMES.map(p => {
    const qr = new Set(Array.from({ length: p }, (_, v) => (v * v) % p));
    return Array.from({ length: p }, (_, s) =>
      Uint8Array.from({ length: p }, (_, z) =>
        qr.has(modNumber(3 * s * (4 * k - 4 * z ** 3 - s ** 3), p)) ? 1 : 0
      )
    );
  });
  const result = { allowed, masks };
  if (filterCache.size >= 32) filterCache.delete(filterCache.keys().next().value);
  filterCache.set(k, result);
  return result;
}

export function checkCandidate(k, s, z, { minimal = true } = {}) {
  k = BigInt(k); s = BigInt(s); z = BigInt(z);
  if (!s) return null;
  const numerator = 4n * (k - z ** 3n) - s ** 3n;
  const denominator = 3n * s;
  if (numerator % denominator) return null;
  const square = numerator / denominator;
  if (square < 0n) return null;
  const v = isqrt(square);
  if (v * v !== square || (s + v) % 2n !== 0n) return null;
  const x = (s + v) / 2n;
  const y = (s - v) / 2n;
  if (minimal && (abs(z) > abs(x) || abs(z) > abs(y))) return null;
  const xyz = [String(x), String(y), String(z)];
  if (!verifyTriple(xyz, Number(k))) throw new Error('final exact cube identity failed');
  return xyz;
}

export function scanCurve(k, d, r, qlo, qhi, { sieve = true, minimal = true, onHit } = {}) {
  if (!Number.isSafeInteger(k) || k < 3 || k > 1000 || ![3, 6].includes(modNumber(k, 9))) {
    throw new RangeError('unsupported regression k');
  }
  d = BigInt(d); r = BigInt(r); qlo = BigInt(qlo); qhi = BigInt(qhi);
  if (d < 2n || d % 3n === 0n || r < 0n || r >= d || (r ** 3n) % d !== mod(BigInt(k), d)) {
    throw new RangeError('invalid modular root');
  }
  if (qhi < qlo || qhi - qlo > 8192n) throw new RangeError('bounded regression interval required');

  const s = d % 3n === BigInt((2 * (Math.floor(k / 3) % 3)) % 3) ? d : -d;
  const counters = emptyCounters();
  counters.curves = 1;
  counters.quotient_points = Number(qhi - qlo + 1n);
  const hits = [];
  const { allowed, masks } = filters(k);
  let qs = [];

  if (sieve) {
    const inv = inverse(d, 243n);
    for (const zmod of allowed[Number(mod(s, 243n))]) {
      const residue = mod((BigInt(zmod) - r) * inv, 243n);
      const first = qlo + mod(residue - qlo, 243n);
      for (let q = first; q <= qhi; q += 243n) qs.push(q);
    }
    qs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    counters.rejected_mod243 = counters.quotient_points - qs.length;
  } else {
    for (let q = qlo; q <= qhi; q++) qs.push(q);
  }

  const smallS = PRIMES.map(p => Number(mod(s, BigInt(p))));
  for (const q of qs) {
    const z = r + d * q;
    if (sieve && mod(BigInt(k) - s - z, 2n) !== 0n) {
      counters.rejected_parity++;
      continue;
    }
    if (sieve && PRIMES.some((p, j) => !masks[j][smallS[j]][Number(mod(z, BigInt(p)))])) {
      counters.rejected_prime++;
      continue;
    }
    counters.exact_tests++;
    const xyz = checkCandidate(k, s, z, { minimal });
    if (xyz) {
      const hit = { xyz, D: String(d), r: String(r), q: String(q) };
      hits.push(hit);
      try { onHit?.({ ...hit, xyz: [...xyz] }); } catch {}
    }
  }

  counters.hits = hits.length;
  return { counters, hits };
}

export function shellInterval(base, ell, tlo, thi, lower, upper, constant, linear) {
  const a0 = base + ell * BigInt(tlo);
  const a1 = base + ell * BigInt(thi);
  const n0 = a0 * a0 * a0 - linear * a0 + constant;
  if (n0 % ell !== 0n) throw new Error('norm lattice divisibility failed');

  const minimumAbsA = a0 >= 0n ? a0 : a1 <= 0n ? -a1 : 0n;
  if (3n * minimumAbsA * minimumAbsA < linear) return [tlo, thi];
  const n1 = a1 * a1 * a1 - linear * a1 + constant;
  if (n1 <= lower || n0 > upper) return [tlo, tlo - 1];

  let first = tlo, last = thi;
  if (n0 <= lower) {
    let left = tlo + 1, right = thi;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const a = base + ell * BigInt(middle);
      if (a * a * a - linear * a + constant <= lower) left = middle + 1;
      else right = middle;
    }
    first = left;
  }
  if (n1 > upper) {
    let left = first, right = thi;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const a = base + ell * BigInt(middle);
      if (a * a * a - linear * a + constant <= upper) left = middle + 1;
      else right = middle;
    }
    last = left - 1;
  }
  return [first, last];
}

function runRow(task, c, row, onHit) {
  const ell = BigInt(c.ell);
  const radius = BigInt(c.radius);
  const width = 2n * radius + 1n;
  const b = (row % width) - radius;
  const cc = row / width - radius;
  const base = offsetBase(ell, b, cc);
  const tlo = c.tlo + BLOCK_SIZE * task.block;
  const thi = Math.min(tlo + BLOCK_SIZE - 1, c.thi);
  const counters = emptyCounters();
  const hits = [];
  const constant = 114n * b * b * b + 12996n * cc * cc * cc;
  const linear = 342n * b * cc;
  const dlo = BigInt(c.dlo);
  const dhi = BigInt(c.dhi);

  const [first, last] = shellInterval(base, ell, tlo, thi, ell * dlo, ell * dhi, constant, linear);
  counters.generators = thi - tlo + 1;
  counters.outside_shell = counters.generators - Math.max(0, last - first + 1);

  for (let t = first; t <= last; t++) {
    const a = base + ell * BigInt(t);
    const n = a * a * a - linear * a + constant;
    if (n % ell !== 0n) throw new Error('norm lattice divisibility failed');
    const d = n / ell;
    if (d <= dlo || d > dhi) {
      counters.outside_shell++;
      continue;
    }
    if (d < 2n || d % 3n === 0n) {
      counters.invalid_d++;
      continue;
    }
    const s = d % 3n === 1n ? d : -d;
    if ([0, 4, 6].includes(Number(mod(s, 8n))) ||
        [0, 19, 76, 95, 114, 133, 171, 209, 304, 323].includes(Number(mod(s, 361n)))) {
      counters.signed_excluded++;
      continue;
    }
    const B = 114n * cc * cc - a * b;
    const C = b * b - a * cc;
    if (gcd(C, d) !== 1n) {
      counters.noninvertible++;
      continue;
    }
    const r = mod(B * inverse(C, d), d);
    if ((r ** 3n) % d !== 114n % d) throw new Error('norm modular root identity failed');

    const zmin = BigInt(c.low) * d > 10n ** 17n ? BigInt(c.low) * d : 10n ** 17n;
    const zmax = BigInt(c.high) * d;
    const [qlo, qhi] = s < 0n
      ? [floorDiv(zmin - r, d) + 1n, floorDiv(zmax - r, d)]
      : [-((zmax + r) / d), -((zmin + r) / d) - 1n];

    const found = scanCurve(114, d, r, qlo, qhi, {
      onHit: onHit && (hit => onHit({ ...hit, abc: [String(a), String(b), String(cc)], t, row: String(row) }))
    });

    for (const key of counterKeys) counters[key] += found.counters[key];
    for (const hit of found.hits) {
      hits.push({ ...hit, abc: [String(a), String(b), String(cc)], t, row: String(row) });
    }
  }

  if (counters.generators !== ['outside_shell', 'invalid_d', 'signed_excluded', 'noninvertible', 'curves'].reduce((s, k) => s + counters[k], 0)) {
    throw new Error('generator accounting failed');
  }
  if (counters.quotient_points !== ['rejected_mod243', 'rejected_parity', 'rejected_prime', 'exact_tests'].reduce((s, k) => s + counters[k], 0)) {
    throw new Error('quotient accounting failed');
  }

  return { counters, hits };
}

export function runTaskCore(input, { onHit } = {}) {
  const task = validateTask(input);
  const c = byId.get(task.context);
  const start = BigInt(task.row);
  const end = start + BigInt(ROWS_PER_TASK) < BigInt(c.totalRows)
    ? start + BigInt(ROWS_PER_TASK)
    : BigInt(c.totalRows);

  const counters = emptyCounters();
  const hits = [];

  for (let row = start; row < end; row++) {
    const found = runRow(task, c, row, onHit);
    for (const key of counterKeys) counters[key] += found.counters[key];
    hits.push(...found.hits);
  }

  return { task, id: taskId(task), counters, hits };
}

export function sha256Sync(str) {
  function r(n, s) { return (n >>> s) | (n << (32 - s)); }
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const b = new TextEncoder().encode(str);
  const len = b.length;
  const bitLen = len * 8;
  const withPadLen = ((len + 8) >> 6) + 1 << 6;
  const pad = new Uint8Array(withPadLen);
  pad.set(b);
  pad[len] = 0x80;
  const view = new DataView(pad.buffer);
  view.setBigUint64(withPadLen - 8, BigInt(bitLen), false);

  const w = new Uint32Array(64);
  for (let i = 0; i < withPadLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + (t << 2), false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = r(w[t - 15], 7) ^ r(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = r(w[t - 2], 17) ^ r(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (((w[t - 16] + s0) | 0) + ((w[t - 7] + s1) | 0)) | 0;
    }

    let a = h0, b_ = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (((h + S1) | 0) + ((ch + k[t]) | 0) + w[t]) | 0;
      const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const maj = (a & b_) ^ (a & c) ^ (b_ & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e;
      e = (d + temp1) | 0;
      d = c; c = b_; b_ = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b_) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(val => (val >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export async function sha256Hex(text) {
  if (globalThis.crypto?.subtle?.digest) {
    try {
      const hash = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text)
      );
      return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
    } catch {}
  }
  return sha256Sync(text);
}

export async function runTask(input, options) {
  const result = runTaskCore(input, options);
  const digest = await sha256Hex(canonicalJSON(result));
  return { ...result, digest };
}
