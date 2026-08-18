"""
AES em Python puro — o suficiente para abrir cookie store de navegador.

macOS  → AES-128-CBC (chave do Keychain via PBKDF2)
Linux  → AES-128-CBC (chave do keyring ou da senha fixa 'peanuts')
Windows→ AES-256-GCM (chave do Local State, desembrulhada com DPAPI)

Sem dependência externa de propósito: o app inteiro é stdlib, e um `pip install`
seria uma barreira a mais para quem não é programador.
"""

SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16")
INV_SBOX = bytearray(256)
for _i, _b in enumerate(SBOX):
    INV_SBOX[_b] = _i
RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36,
        0x6C, 0xD8, 0xAB, 0x4D)


def _xtime(a):
    a <<= 1
    return (a ^ 0x1B) & 0xFF if a & 0x100 else a


def _mul(a, b):
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r


class AES:
    """AES-128 e AES-256 (o que os navegadores usam)."""

    def __init__(self, key):
        nk = len(key) // 4
        if nk not in (4, 8):
            raise ValueError("chave precisa ter 16 ou 32 bytes")
        self.rounds = nk + 6
        w = [list(key[i:i + 4]) for i in range(0, len(key), 4)]
        for i in range(nk, 4 * (self.rounds + 1)):
            t = list(w[i - 1])
            if i % nk == 0:
                t = [SBOX[x] for x in t[1:] + t[:1]]
                t[0] ^= RCON[i // nk - 1]
            elif nk == 8 and i % nk == 4:
                t = [SBOX[x] for x in t]
            w.append([a ^ b for a, b in zip(w[i - nk], t)])
        self.rk = [bytes(b for word in w[r * 4:r * 4 + 4] for b in word)
                   for r in range(self.rounds + 1)]

    def encrypt_block(self, block):
        s = [b ^ k for b, k in zip(block, self.rk[0])]
        for rnd in range(1, self.rounds + 1):
            s = [SBOX[b] for b in s]                                  # SubBytes
            s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]        # ShiftRows
            if rnd != self.rounds:                                    # MixColumns
                out = []
                for c in range(4):
                    a = s[c * 4:c * 4 + 4]
                    out += [
                        _mul(a[0], 2) ^ _mul(a[1], 3) ^ a[2] ^ a[3],
                        a[0] ^ _mul(a[1], 2) ^ _mul(a[2], 3) ^ a[3],
                        a[0] ^ a[1] ^ _mul(a[2], 2) ^ _mul(a[3], 3),
                        _mul(a[0], 3) ^ a[1] ^ a[2] ^ _mul(a[3], 2),
                    ]
                s = out
            s = [b ^ k for b, k in zip(s, self.rk[rnd])]
        return bytes(s)

    def decrypt_block(self, block):
        s = [b ^ k for b, k in zip(block, self.rk[self.rounds])]
        for rnd in range(self.rounds - 1, -1, -1):
            s = [s[(i - 4 * (i % 4)) % 16] for i in range(16)]        # InvShiftRows
            s = [INV_SBOX[b] for b in s]                              # InvSubBytes
            s = [b ^ k for b, k in zip(s, self.rk[rnd])]
            if rnd:                                                   # InvMixColumns
                out = []
                for c in range(4):
                    a = s[c * 4:c * 4 + 4]
                    out += [
                        _mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9),
                        _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13),
                        _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11),
                        _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14),
                    ]
                s = out
        return bytes(s)


def cbc_decrypt(key, iv, data):
    aes = AES(key)
    out, prev = bytearray(), iv
    for i in range(0, len(data) - len(data) % 16, 16):
        blk = data[i:i + 16]
        out += bytes(a ^ b for a, b in zip(aes.decrypt_block(blk), prev))
        prev = blk
    pad = out[-1] if out else 0
    if 1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad:
        del out[-pad:]
    return bytes(out)


# ------------------------------------------------------------------ AES-GCM

def _gf_mul(x, y):
    """Multiplicação no GF(2^128) do GCM (bit a bit; são poucos blocos)."""
    z, v = 0, y
    for i in range(127, -1, -1):
        if (x >> i) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ (0xE1 << 120)
        else:
            v >>= 1
    return z


def _ghash(h, data):
    y = 0
    for i in range(0, len(data), 16):
        blk = data[i:i + 16].ljust(16, b"\0")
        y = _gf_mul(y ^ int.from_bytes(blk, "big"), h)
    return y


def gcm_decrypt(key, nonce, ciphertext, tag=None, aad=b""):
    """AES-GCM. Verifica a tag quando ela é passada."""
    aes = AES(key)
    h = int.from_bytes(aes.encrypt_block(b"\0" * 16), "big")

    if len(nonce) == 12:
        j0 = nonce + b"\0\0\0\1"
    else:
        s = _ghash(h, nonce + b"\0" * ((16 - len(nonce) % 16) % 16)
                   + (0).to_bytes(8, "big") + (len(nonce) * 8).to_bytes(8, "big"))
        j0 = s.to_bytes(16, "big")

    ctr = int.from_bytes(j0, "big")
    out = bytearray()
    for i in range(0, len(ciphertext), 16):
        ctr = (ctr & ~0xFFFFFFFF) | ((ctr + 1) & 0xFFFFFFFF)
        ks = aes.encrypt_block(ctr.to_bytes(16, "big"))
        blk = ciphertext[i:i + 16]
        out += bytes(a ^ b for a, b in zip(blk, ks))

    if tag is not None:
        pad = lambda d: d + b"\0" * ((16 - len(d) % 16) % 16)
        s = _ghash(h, pad(aad) + pad(ciphertext)
                   + (len(aad) * 8).to_bytes(8, "big")
                   + (len(ciphertext) * 8).to_bytes(8, "big"))
        expect = bytes(a ^ b for a, b in
                       zip(s.to_bytes(16, "big"), aes.encrypt_block(j0)))
        if expect != tag:
            raise ValueError("tag GCM inválida — chave errada ou dado corrompido")
    return bytes(out)
