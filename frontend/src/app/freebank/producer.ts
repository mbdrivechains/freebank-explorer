import { BlockExtended } from '@interfaces/node-api.interface';
import { PRODUCER_LOGOS } from '@app/freebank/producer-logos';

// Who produced a FreeBank block: the party that won the BMM for it and earns its fees. Pure TypeScript.
// A producer names itself with a coinbase tag (freebankd v0.2.14, `coinbasetag=`), written after the height and the
// extra nonce. The backend matches the coinbase text against the producer list (explorer deploy/make-producers.py,
// built from the eCash pool list, mining-pools-pr), so a listed producer arrives as extras.pool. A tag the list does
// not know is shown as its own text, in quotes. A block without a tag (every block before v0.2.14, and the genesis
// block, whose coinbase holds the chain's placeholder text) has no producer. Tags are self-declared, and the words say so.

export interface BlockProducer {
  name: string;           // 'FreeBank'; for an unlisted tag, the tag's text in quotes: '“MyPool”'
  logo: string | null;    // '/resources/freebank-producers/freebank.svg'; null without one
  listed: boolean;        // false: a tag the producer list does not know
  help: string;           // the tooltip: what the name means
}

const MAX_TAG = 32;       // characters of an unlisted tag shown
const CACHE_SIZE = 512;
const cache = new Map<string, BlockProducer | null>();

interface ScriptElement {
  end: number;            // offset just past the element
  data: Uint8Array | null;  // the pushed bytes; null for an opcode that pushes nothing
}

/** The script's elements in order; stops at the first push that runs past the end (ok = false). */
function scriptElements(bytes: Uint8Array): { elements: ScriptElement[], ok: boolean } {
  const elements: ScriptElement[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++];
    let len = -1;
    if (op >= 1 && op <= 75) {
      len = op;
    } else if (op === 0x4c && i + 1 <= bytes.length) {
      len = bytes[i]; i += 1;
    } else if (op === 0x4d && i + 2 <= bytes.length) {
      len = bytes[i] | (bytes[i + 1] << 8); i += 2;
    } else if (op === 0x4e && i + 4 <= bytes.length) {
      len = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0; i += 4;
    } else if (op >= 0x4c && op <= 0x4e) {
      return { elements, ok: false };
    }
    if (len < 0) {
      elements.push({ end: i, data: op === 0 ? new Uint8Array(0) : null });   // OP_0 pushes nothing, OP_1..16 etc.
      continue;
    }
    if (i + len > bytes.length) {
      return { elements, ok: false };
    }
    elements.push({ end: i + len, data: bytes.subarray(i, i + len) });
    i += len;
  }
  return { elements, ok: true };
}

function hexBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * The producer's tag in a coinbase scriptSig (hex): what follows the height and the extra nonce, as printable text,
 * without surrounding slashes, at most MAX_TAG characters. '' when there is none.
 *   '01250101'                          -> ''                (no tag: every block before v0.2.14)
 *   '01250101' + '0f' + 'ecxfreebank.com' -> 'ecxfreebank.com' (the tag as one push)
 *   '01250101' + '11' + '/ecxfreebank.com/' -> 'ecxfreebank.com'
 * Bytes after the extra nonce that are not clean pushes are read as they are, so a tag appended without a push
 * opcode still shows.
 */
export function coinbaseTag(scriptSigHex: string): string {
  const bytes = hexBytes(scriptSigHex);
  if (!bytes) {
    return '';
  }
  const { elements, ok } = scriptElements(bytes);
  if (elements.length < 2) {
    return '';
  }
  const rest = elements.slice(2);
  let tagBytes: Uint8Array;
  if (ok && rest.every((e) => e.data)) {
    const parts = rest.map((e) => e.data as Uint8Array);
    tagBytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    parts.forEach((p) => { tagBytes.set(p, o); o += p.length; });
  } else {
    tagBytes = bytes.subarray(elements[1].end);
  }
  let text = '';
  tagBytes.forEach((b) => { text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ' '; });
  text = text.replace(/\s+/g, ' ').trim().replace(/^\/+|\/+$/g, '').trim();
  return text.length > MAX_TAG ? text.slice(0, MAX_TAG - 1) + '…' : text;
}

/** The tooltip for a block whose coinbase names no producer; poolName is the eCash pool that carried it, if known. */
export function unknownProducerHelp(poolName?: string | null): string {
  return 'This block\'s coinbase names no producer: producers tag their blocks since freebankd v0.2.14.'
    + (poolName ? ` The eCash block carrying it was mined by ${poolName}.` : '');
}

/** The block's producer, or null when the block names none. */
export function blockProducer(block: BlockExtended): BlockProducer | null {
  const pool = block?.extras?.pool;
  const raw = block?.extras?.coinbaseRaw || '';
  if (!block || block.height === 0) {
    return null;
  }
  const key = `${block.id}:${pool?.id}:${pool?.slug}:${pool?.name}:${raw}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let producer: BlockProducer | null = null;
  if (pool && pool.id !== 0 && pool.slug && pool.slug !== 'unknown') {
    const logo = PRODUCER_LOGOS[pool.slug];
    producer = {
      name: pool.name,
      logo: logo ? '/resources/freebank-producers/' + logo : null,
      listed: true,
      help: `Produced by ${pool.name}, by the tag in its coinbase: the producer won the BMM for this block and earns `
        + 'its fees. Producers name themselves; this tag is in the producer list.',
    };
  } else {
    const tag = coinbaseTag(raw);
    producer = tag ? {
      name: `“${tag}”`,
      logo: null,
      listed: false,
      help: `The coinbase is tagged “${tag}”, a name its producer gave itself that is not in the producer list. `
        + 'The producer won the BMM for this block and earns its fees.',
    } : null;
  }
  if (cache.size >= CACHE_SIZE) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, producer);
  return producer;
}
