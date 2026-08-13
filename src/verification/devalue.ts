/**
 * Minimal `devalue` codec for bahn.expert's tRPC gateway.
 *
 * bahn.expert serializes tRPC inputs and outputs with `devalue`, not plain JSON. The wire form is
 * a flat array whose element 0 holds the **root representation inline**; every number that appears
 * *inside* a container is an index into that same array, while a scalar sitting in its own slot is
 * a literal value. Special types are tagged arrays (`["Date", "<ISO>"]`).
 *
 * That distinction is the whole trick: `{ "journeyNumber": 1 }` means "journeyNumber is whatever
 * lives at index 1", but `flat[1] = 84805` is the number itself. Treating every number as a
 * reference walks off the end of the array; treating none as references loses the graph.
 *
 * Plain JSON payloads are rejected by the server with `Invalid input`, so this codec is required
 * to talk to the API at all.
 */

/** Negative slots devalue reserves for values JSON cannot express. */
const UNDEFINED = -1;
const HOLE = -2;
const NAN = -3;
const POSITIVE_INFINITY = -4;
const NEGATIVE_INFINITY = -5;
const NEGATIVE_ZERO = -6;

/** Tagged container types devalue emits as `[tag, ...]`. */
const TAGGED = new Set(['Date', 'Set', 'Map', 'RegExp', 'BigInt', 'URL']);

type Flat = readonly unknown[];

function isReference(value: unknown): value is number {
  return typeof value === 'number';
}

/**
 * Decode a devalue flat array into a plain value.
 *
 * Cycles are tolerated: a slot under construction resolves to `null` rather than recursing
 * forever, which is enough for the read-only shapes this project consumes.
 */
export function parseDevalue(flat: Flat): unknown {
  if (flat.length === 0) return null;
  const resolved = new Map<number, unknown>();

  const byIndex = (index: number): unknown => {
    if (index < 0) {
      switch (index) {
        case UNDEFINED:
        case HOLE:
          return null;
        case NAN:
          return Number.NaN;
        case POSITIVE_INFINITY:
          return Number.POSITIVE_INFINITY;
        case NEGATIVE_INFINITY:
          return Number.NEGATIVE_INFINITY;
        case NEGATIVE_ZERO:
          return -0;
        default:
          return null;
      }
    }
    if (resolved.has(index)) return resolved.get(index);
    if (index >= flat.length) return null;
    resolved.set(index, null);
    const value = fromRepresentation(flat[index]);
    resolved.set(index, value);
    return value;
  };

  const fromRepresentation = (representation: unknown): unknown => {
    if (Array.isArray(representation)) {
      const [tag] = representation;
      if (typeof tag === 'string' && TAGGED.has(tag)) {
        const payload = representation[1];
        switch (tag) {
          case 'Date':
          case 'RegExp':
          case 'URL':
            return typeof payload === 'string' ? payload : byIndex(payload as number);
          case 'BigInt':
            return typeof payload === 'string' ? payload : String(byIndex(payload as number));
          case 'Set':
            return representation.slice(1).map((entry) => byIndex(entry as number));
          case 'Map': {
            const map: Record<string, unknown> = {};
            for (let i = 1; i < representation.length; i += 2) {
              map[String(byIndex(representation[i] as number))] = byIndex(
                representation[i + 1] as number,
              );
            }
            return map;
          }
          default:
            return null;
        }
      }
      return representation.map((entry) => (isReference(entry) ? byIndex(entry) : entry));
    }
    if (representation !== null && typeof representation === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(representation as Record<string, unknown>)) {
        out[key] = isReference(entry) ? byIndex(entry) : entry;
      }
      return out;
    }
    return representation;
  };

  return fromRepresentation(flat[0]);
}

/**
 * Encode a value into devalue's flat array, matching the shape bahn.expert's client emits:
 * the root representation sits inline at index 0 and children are appended from index 1.
 */
export function stringifyDevalue(value: unknown): unknown[] {
  const flat: unknown[] = [null];

  const child = (entry: unknown): number => {
    const index = flat.length;
    flat.push(null);
    flat[index] = representationOf(entry);
    return index;
  };

  const representationOf = (entry: unknown): unknown => {
    if (entry instanceof Date) return ['Date', entry.toISOString()];
    if (Array.isArray(entry)) return entry.map(child);
    if (entry !== null && typeof entry === 'object') {
      const out: Record<string, number> = {};
      for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
        out[key] = child(nested);
      }
      return out;
    }
    return entry;
  };

  flat[0] = representationOf(value);
  return flat;
}
