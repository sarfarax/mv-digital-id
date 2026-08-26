# Maldives Verifiable Digital ID

A digitally signed identity card carrying the front-side fields of a Maldivian
ID card, plus a QR code that binds those fields **and the cardholder's
photograph** to a single signature. A browser-based verifier reads the code,
checks the signature offline, then re-photographs the portrait and confirms it
still hashes to the value the issuer signed.

The point is the photo binding. A signature over text alone proves the printed
words were issued by the authority, but says nothing about the face beside
them: take a genuine card, replace the photograph, and the QR still verifies.
Including a perceptual hash of the portrait in the signed message closes that
gap.

Static pages, no build step, no backend. Every check runs in the browser.

## Running it

ES modules need to be served over HTTP; opening the files directly with
`file://` will not work.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

- `index.html` — what the system does and what it deliberately does not do
- `issuer.html` — fill in details, frame a portrait, sign, print a card
- `scanner.html` — scan a card, check the signature, check the portrait
- `tests.html` — runs the whole pipeline in the browser, including a forged card

### Try it without a camera or printer

`samples/` contains two ready-made cards. On the verify page, switch to
**Upload an image** and drop in:

- `card-genuine.png` — signature valid, portrait matches, card accepted
- `card-forged.png` — the *same untampered QR code* with a different face
  printed beside it. The signature still passes; the portrait check is what
  catches it.

## What the QR code contains

Fields are joined with `#`, following the convention of
[oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes):

```
MV1#A123456#Aishath Nasheeda Ibrahim#F#1991-04-17#+960 771 2345#Ma. Blue Heaven, Male, Maldives#2c3cbcbcf0d2d20b#<192 hex chars>
\_________________________________ signed message _________________________________/\__ signature __/
```

The 16 hex characters before the signature are the portrait's 64-bit perceptual
hash. Everything before the signature is signed as one string with BLS12-381,
then the whole thing is compressed with LZString and drawn as a QR code:
305 characters in, 276 bytes out, a version 11 symbol.

Because `#` separates fields it can never appear inside one. Rather than
inventing an escaping scheme, `sanitizeField()` strips it at input time along
with newlines and repeated whitespace.

Two encodings are available. **Binary byte mode** is the default and the
smaller of the two. **URL-safe text mode** costs about a third more payload but
survives readers that mangle raw bytes. The scanner detects which was used
rather than being told.

## The portrait hash

`js/phash.js` is a JavaScript port of `ph_dct_imagehash` from
[pHash.org](https://www.phash.org):

1. Luminance, as CImg's `RGBtoYCbCr` channel 0
2. A 7x7 mean filter
3. Resample to 32x32
4. DCT using pHash's `ph_dct_matrix` basis, `D = C · img · Cᵀ`
5. Take the 8x8 block at offset `(1,1)`, skipping the DC row and column
6. One bit per coefficient, set when it exceeds the median

Two deviations from the C original, both deliberate:

- pHash convolves with a 7x7 kernel of **ones**, which sums rather than
  averages. Dividing by the kernel area scales every DCT coefficient equally,
  so the median comparison in step 6 is unaffected; averaging just keeps values
  in the original 0–255 range.
- pHash relies on CImg's default **nearest-neighbour** resize. Nearest-neighbour
  throws away most pixels on a large downscale and makes the hash jitter under
  sub-pixel shifts, which is exactly the noise a camera introduces, so this port
  uses area averaging instead. Both sides of the system call the same function,
  so they stay consistent.

### Why the portrait is normalised first

The issuer and the verifier have to hash comparable images or the distance
between them means nothing. Both funnel every portrait through
`canonicalPortrait()` in `js/card.js`: crop to 3:4, scale to 300x400,
desaturate. The card prints exactly that raster, so what is hashed at issuance
is what a camera later sees.

The portrait is grayscale on purpose. It makes the printed artefact and the
hashed artefact the same thing, which removes a whole class of colour-profile
and white-balance drift from the comparison.

### Finding the portrait in a photograph

The verifier never asks the operator to line up a box. jsQR reports the QR
symbol's four corners, and since the card is a rigid layout with the QR at a
known millimetre rectangle, those four correspondences determine the homography
from card millimetres to frame pixels. The portrait rectangle is then
inverse-warped out of the frame with perspective and rotation removed.

That is why `PORTRAIT_RECT` and `QR_RECT` in `js/card.js` are the single source
of truth: `applyCardGeometry()` publishes them to CSS so the printed card and
the scanner's maths cannot drift apart. Changing one rectangle changes both.

The QR is also deliberately large. A signed payload needs 61 modules across, so
at the 25 mm width in `QR_RECT` each module is about 0.41 mm — fine for a
printer and within reach of a phone camera. Shrinking that rectangle is the
quickest way to make cards unscannable.

## Tuning the match threshold

Comparison is Hamming distance over 64 bits, and the scanner's slider defaults
to accepting 12. Measured on the bundled fixtures:

| Case | Distance |
| --- | --- |
| Card scanned flat, or read from a screen | 0 |
| Card photographed at an angle, with noise and a brightness shift | 8 |
| A different person's face | 34–36 |

The gap is wide, which is what makes the check useful. Raise the tolerance if
genuine cards are being rejected under bad lighting, but every bit of slack
makes it easier for a similar-looking face to pass. Above roughly 20 the check
stops meaning very much.

## Tests

Browser tests, at `tests.html`, cover everything that needs a canvas: drawing a
real QR onto a card, synthesising a photograph of it at an angle, finding the
code again, recovering the portrait through the homography, and rejecting a
forgery. 28 checks.

Command-line tests cover the pieces that do not:

```bash
node tools/phash-selftest.mjs     # hash stability, tolerance, discrimination
node tools/payload-selftest.mjs   # signing, encoding, tamper detection
```

Other scripts:

```bash
node tools/make-keypair.mjs       # generate a BLS12-381 issuer keypair
node tools/make-samples.mjs       # regenerate the sample portraits
node tools/make-card.mjs          # regenerate the genuine and forged sample cards
```

`package.json` exists only so Node treats these `.js` modules as ES modules.
There are no dependencies to install.

## Layout

```
index.html          overview
issuer.html         issuing UI          js/issuer.js
scanner.html        verifying UI        js/scanner.js
tests.html          pipeline tests      js/tests.js
js/card.js          card geometry, portrait normalisation, homography
js/phash.js         the pHash DCT hash
js/payload.js       schema, validation, signing, QR encode and decode
js/issuer-key.js    the demonstration issuing authority
js/lib/             vendored third-party code, see js/lib/README.md
tools/              Node scripts: tests, keypairs, sample generation
samples/            portraits and ready-made cards
```

## What this is not

A working demonstration, not a deployable identity system. The gaps are worth
stating plainly:

- **The signing key is in this repository.** Anyone can mint a card the bundled
  scanner accepts. A real issuer keeps that key in an HSM and never exports it.
- **No revocation and no expiry.** A signature says "this was issued", never
  "this is still valid". A card reported stolen still verifies. Any real
  deployment needs a status check, which necessarily means being online.
- **The portrait check compares a photograph to a photograph.** It confirms the
  picture on the card is the signed one. It does not confirm that the person
  holding the card is the person in the picture; that is a job for a human
  or for face recognition, neither of which is here.
- **A perceptual hash is a similarity measure, not a cryptographic one.** It is
  designed to survive re-photographing, which means it tolerates change by
  construction. Treat it as a tamper check, not a proof of identity.
- **Nothing is encrypted.** Anyone who scans the card reads every field —
  exactly as they could by looking at it. Whether a phone number and home
  address belong in a machine-readable code that any passer-by can scan is a
  policy question this repository does not answer.

## Credits

- [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes) — the
  BLS-signed QR approach this is built on
- [Noble BLS12-381](https://github.com/paulmillr/noble-bls12-381) — signing
- [LZString](https://pieroxy.net/blog/pages/lz-string/) — payload compression
- [Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) — writing codes
- [jsQR](https://github.com/cozmo/jsQR) — reading codes
- [pHash](https://www.phash.org) — the perceptual hash algorithm

## Licence

MIT. Vendored dependencies keep their own licences; see `js/lib/README.md`.
