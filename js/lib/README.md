# Vendored libraries

These files are third-party and are checked in verbatim so the project works
offline with no build step and no package manager.

| File | Source | License |
| --- | --- | --- |
| `noble-bls.js` | [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes/blob/master/noble-bls.js), an ES-module repackaging of [paulmillr/noble-bls12-381](https://github.com/paulmillr/noble-bls12-381) | MIT |
| `lz-string.js` | [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes/blob/master/lz-string.js), an ES-module repackaging of [LZString](https://pieroxy.net/blog/pages/lz-string/) | MIT |
| `qr-gen-lib.js` | [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes/blob/master/qr-gen-lib.js), an ES-module repackaging of [Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) | MIT |
| `jsQR.js` | [cozmo/jsQR](https://github.com/cozmo/jsQR) v1.4.0, via unpkg | Apache-2.0 |

The Nayuki library only *generates* QR codes, so `jsQR` is added to *read*
them. It is the UMD build and is loaded with a plain `<script>` tag, which
sets `window.jsQR`; the other three are ES modules loaded with `import`.

## Local changes

`noble-bls.js` upstream ends with `console.log(nobleBLS, math_2);`, a leftover
debug statement that dumps the entire curve implementation to the console on
every page load. That one line is commented out. Nothing else is modified.

Note that `noble-bls.js` is browser-only: it opens with
`var globals = typeof global === 'undefined' ? self : global;` while declaring
`var global` further down the same module, so the hoisted declaration makes the
first line fall through to `self`. The Node scripts under `tools/` work around
this with `tools/browser-shim.mjs`.

## Exports in use

- `noble-bls.js` -> `nobleBLS` (`getPublicKey`, `sign`, `verify`)
- `lz-string.js` -> `LZString` (`compressToUint8Array`, `decompressFromUint8Array`, `compressToEncodedURIComponent`, `decompressFromEncodedURIComponent`)
- `qr-gen-lib.js` -> `qrcodegen` (`QrCode.encodeBinary`, `QrCode.encodeText`, `QrCode.Ecc`)
