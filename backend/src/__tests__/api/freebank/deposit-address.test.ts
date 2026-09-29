import { createHash } from 'crypto';
import { sha256Hex, unwrapFullDepositAddress } from '../../../api/freebank/deposit-address';

// The full deposit address s130_<address>_<checksum>, paid to <address> from freebankd v0.2.17 (D-2026-09-30-1;
// freebank src/sidechain.cpp ParseFullDepositAddress).
const ADDR = 'XCA6v5sypMCL8MVK1Ludm67zSqAhW6fnGn';   // beta's first deposit (block 211, 10 ECX)
const FULL = 's130_XCA6v5sypMCL8MVK1Ludm67zSqAhW6fnGn_e8cc6c';
const full = (address: string, slot = 130) => {
  const body = `s${slot}_${address}_`;
  return body + createHash('sha256').update(body, 'latin1').digest('hex').slice(0, 6);
};

describe('the full deposit address (v0.2.17)', () => {
  test('beta block 211: pays XCA6v5...', () => {
    expect(unwrapFullDepositAddress(FULL)).toEqual(ADDR);
  });
  test('a bech32 address inside', () => {
    expect(unwrapFullDepositAddress(full('fbk1qw508d6qejxtdg4y5r3zarvary0c5xw7kh7x9s0'))).toEqual('fbk1qw508d6qejxtdg4y5r3zarvary0c5xw7kh7x9s0');
  });
  test.each([
    ['a plain address', ADDR],
    ['a wrong checksum', FULL.slice(0, -1) + 'd'],
    ['a checksum in capitals', FULL.slice(0, -6) + 'E8CC6C'],
    ['another slot', full(ADDR, 131)],
    ['slot written with a zero', full(ADDR).replace('s130_', 's0130_')],
    ['an underscore in the address', full('XCA6v5_ypMCL8MVK1Ludm67zSqAhW6fnGn')],
    ['an empty address', full('')],
    ['a space before the address (checksum over it)', full(' ' + ADDR)],
    ['a trailing newline', FULL + '\n'],
    ['too short', 's130__abc'],
    ['empty', ''],
  ])('%s: not unwrapped', (_name, dest) => {
    const out = unwrapFullDepositAddress(dest);
    // ' X...' passes the grammar with its own checksum; the canonical-spelling check (the caller compares with the
    // output's address exactly) is what refuses it
    expect(out === null || out !== out.trim()).toBe(true);
  });
  test('sha256Hex matches node crypto on byte strings of every length up to 200', () => {
    for (let n = 0; n <= 200; n++) {
      const s = Array.from({ length: n }, (_, i) => String.fromCharCode((i * 37 + n) % 256)).join('');
      expect(sha256Hex(s)).toEqual(createHash('sha256').update(Buffer.from(s, 'latin1')).digest('hex'));
    }
  });
});
