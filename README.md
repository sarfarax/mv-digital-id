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

The complete technical specification — card geometry, both perceptual
templates bit by bit, the signed message grammar, the signature scheme, the
verification and verdict rules, the face code calibration, and test vectors
for independent implementations — is in
**[SPECIFICATION.md](SPECIFICATION.md)**. This README is the overview.

## Running it

ES modules need to be served over HTTP; opening the files directly with
`file://` will not work.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

- `index.html` — what the system does and what it deliberately does not do
- `issuer.html` — fill in details, frame a portrait, choose Standard or
  Enhanced, sign, print a card
- `scanner.html` — scan a card, check the signature, check the portrait and,
  for Enhanced cards, check the person presenting it
- `tests.html` — runs the whole pipeline in the browser, including a forged card
- `proposal.html` — stakeholder paper: problem, national context, technology, rollout
- `deck.html` — presentation of the same argument, with live demo links

### Try it without a camera or printer

`samples/` contains five ready-made cards (and the real photographs they were
built from). On the verify page, switch to **Upload an image** and drop in:

- `card-genuine.png` — signature valid, portrait matches, card accepted
- `card-forged.png` — the *same untampered QR code* with a different face
  printed beside it. The signature still passes; the portrait check is what
  catches it.
- `card-expired.png` — correctly signed and correctly photographed, but dated
  two years ago. Nothing cryptographic is wrong with it; only the expiry check
  turns it away.
- `card-tampered.png` — printed fields rewritten and the QR re-encoded to match;
  the signature is what fails.
- `card-enhanced.png` — an Enhanced (MV3) card. Steps 1 and 2 pass as for the
  genuine card; in step 3, upload `portrait-2.jpg` as the person presenting it
  (accepted) and then `portrait-1.jpg` (rejected as a different person).

Sample portraits (`portrait-1.jpg` … `portrait-4.jpg`) are AI-generated faces
of people who do not exist, in the public domain (sources in
[samples/ATTRIBUTION.md](samples/ATTRIBUTION.md)). Every sample card is marked
SPECIMEN and signed by a fictional demo authority whose secret key is in this
repository, so none of them is, or can pass for, a real identity document.

## What the QR code contains

Fields are joined with `#`, following the convention of
[oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes):

```
MV2#A123456#Aishath Nasheeda Ibrahim#F#1991-04-17#2036-08-27#Ma. Blue Heaven, Male, Maldives#8c00fd29c7f60ed3#<192 hex chars>
\________________________________ signed message _________________________________/\__ signature __/
```

The 16 hex characters before the signature are the portrait's 64-bit perceptual
hash. Everything before the signature is signed as one string with BLS12-381,
then the whole thing is compressed with LZString and drawn as a QR code:
302 characters in, about 270 bytes out, a version 10 symbol (57 modules).

An Enhanced card uses the `MV3` prefix and adds one field after the photo hash,
the 32-hex-character face code (see [Enhanced cards](#enhanced-cards-mv3)):
335 characters, about 290 bytes, a version 11 symbol (61 modules).

The fields are positional, which is why the version prefix matters. `MV1` had a
phone number where `MV2` has the expiry date, so a reader that accepted both
would label a phone number as an expiry date. `parseMessage()` accepts exactly
`MV2` and `MV3`, checks that the field count matches the prefix, and refuses
anything else rather than guessing. The prefix is inside the signature, so an
MV3 card cannot be passed off as MV2 by deleting its face code.

Because `#` separates fields it can never appear inside one. Rather than
inventing an escaping scheme, `sanitizeField()` strips it at input time along
with newlines and repeated whitespace.

Two encodings are available. **Binary byte mode** is the default and the
smaller of the two. **URL-safe text mode** costs about a third more payload but
survives readers that mangle raw bytes. The scanner detects which was used
rather than being told.

The exact grammar, parsing rules, signature parameters and worked examples with
real signatures are in [SPECIFICATION.md §7–9 and §17](SPECIFICATION.md#7-signed-message).

## Why not a URL QR?

The familiar pattern — a QR that opens `https://verify.example.gov/card?id=…` and
shows a green tick — is weak for identity.

Anyone can print a QR code. A forger does not need cryptography; they need a
domain that *looks* official and a page that *looks* like a verifier. At scan
time the browser renders a plausible response and the clerk sees what they
expected. Nothing on the card was checked.

Clone domains are a routine phishing technique: `verify-dnr.gov.mv`,
`dnr-verify.gov.mv`, `dnr.gov-mv.com`, or homographs with visually similar
characters. Detecting the wrong domain means inspecting the URL bar character
by character, under time pressure, often on someone else's phone. That is not a
control.

A link QR also fails offline — no data, no server, no verdict. Here the QR
carries the signed evidence, the verifier pins one public key, and BLS12-381
either passes or fails with no network call. A cloned website cannot forge the
signature however convincing its HTML is. Online status checks still belong
beside this for revocation, but they should not replace cryptographic proof.

## Enhanced cards (MV3)

Every card is issued at one of two assurance levels. Both are implemented.

| Level | Schema | Proves |
|-------|--------|--------|
| **Standard** | MV2 | Card is genuine, unaltered, in date; printed photo matches the signed hash |
| **Enhanced** | MV3 | All of the above, plus the person presenting the card matches a signed face code |

The photo hash proves the *picture* on the card is the one the authority
signed. It cannot tell whether the person holding the card is the person in
the picture. Enhanced cards add a signed template of the face itself, so the
verifier can compare it with the person standing in front of the camera.

### How the face code works

`js/facecode.js`:

1. Find the face and compute a 128-dimensional embedding with
   [face-api](https://github.com/vladmandic/face-api) (TensorFlow.js; tiny face
   detector, 68-point landmarks, ResNet-34 recognition network). Images are
   converted to greyscale first, the same as the printed portrait.
2. Subtract a population mean embedding (`js/facecode-params.js`).
3. Project onto 128 fixed random hyperplanes (±1 vectors from a seeded integer
   PRNG, so every JavaScript engine reproduces them exactly). Each bit records
   which side of a hyperplane the face falls on.
4. The result is 128 bits, 32 hex characters, appended to the signed message.

A verifier repeats steps 1–3 on a photo of the person and counts differing
bits. The fraction of differing bits tracks the angle between the two
embeddings, so the same face stays close and different faces land far apart.
This is a locality-sensitive hash, not a cryptographic one: a cryptographic
hash of floating-point embeddings would never match twice.

Centring is what makes it work. Raw embeddings share a large common component,
so every face sits in a narrow cone and different people differ by only a
handful of bits. The mean is estimated by `tools/calibrate-facecode.mjs` on
[Labeled Faces in the Wild](https://vis-www.cs.umass.edu/lfw/); only the
128-number mean and summary statistics are committed, never the photographs. A
national deployment would recompute it from its own enrolment photographs.

The normative algorithm — pinned model files and hashes, padding and detector
ladder, the PRNG, bit packing, calibration method and test vectors — is in
[SPECIFICATION.md §6 and §12](SPECIFICATION.md#6-face-code-mv3).

### Measured accuracy

On LFW (500 faces for the mean; 300 same-person pairs and 44,850
different-person pairs held out for evaluation):

| | Uncentred | Centred (shipped) |
| --- | --- | --- |
| Median distance, same person | 12 bits | 33 bits |
| Median distance, different people | 22 bits | 64 bits |
| Equal error rate | 13.1% | 6.7% |
| Same-person pairs accepted at 0.1% false accept | 21% | 57% (threshold 34) |
| Same-person pairs accepted at ~1% false accept | 40% | 76% (threshold 40) |

The scanner defaults to **34 bits**, the strict 0.1% point; the slider can
move it. LFW same-person pairs are often years apart with different pose and
lighting, which is harder than matching an ID photo against the same person at
a counter. For comparison, the unbinarised face-api embedding reaches 83% and
92% at the same two false-accept rates, so most of the shortfall is the model
itself; 256 bits would recover some of the rest at the cost of a larger QR.

On the bundled samples:

| Case | Distance |
| --- | --- |
| Same portrait, darkened, washed out, blurred, downsampled, noisy, shifted | 0–8 bits |
| Card printed, then photographed at an angle with noise (browser test) | 7–11 bits |
| Original colour photo of the holder vs the signed greyscale portrait | 2–4 bits |
| `portrait-1.jpg`, a different woman | **40–43 bits** |
| `portrait-3.jpg` and `portrait-4.jpg`, two more different women | 44 bits |

The bundled faces all clear the threshold, but not by much: `portrait-1.jpg` is
only 6–9 bits above it, and its raw face-api distance to the holder is 0.60,
exactly on face-api's own "same person" line. An earlier sample set of real
passport-standard photographs did worse — different women of similar age,
photographed under the same standard, sat at 32–38 bits, and one pair fell
inside the threshold (raw distances 0.46–0.56). So this is the model, not the
binarisation: it separates similar-looking faces far less well than it
separates LFW. **The Enhanced tier should
not be relied on until it has been measured on Maldivian enrolment photographs,
and probably moved to a stronger embedding model.** The schema already pins
the model to the `MV3` prefix, so a better one would ship as a new version.

### Issuing and verifying

- **Issuance** — choose **Enhanced** in the portrait step. The face code is
  computed from the same normalised greyscale portrait that is printed and
  hashed, so the signed template describes the photograph on the card. Signing
  is blocked until a face is found.
- **Verification** — step 3 on the verify page appears for MV3 cards only. Use
  the front camera or upload a photo of the person; the code is computed on the
  device and compared with the signed one. A demonstration button compares the
  portrait read from the card instead, which shows the code surviving print and
  re-capture but says nothing about who is holding the card.
- **Lazy loading** — the face models are about 7 MB (`models/`). They are
  fetched the first time an Enhanced card needs them and never for Standard
  cards. First use takes a few seconds; after that an embedding takes tens of
  milliseconds with WebGL.
- **Privacy** — a face template is a biometric identifier that can link a
  person across systems. It is stored only on the card, computed and compared
  on the verifying device, and never uploaded. Rolling out the Enhanced tier
  still needs a privacy impact assessment and a policy decision on who may
  run step 3.

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

Bit order, median rule and the homography sampling are specified in
[SPECIFICATION.md §4–5](SPECIFICATION.md#4-portrait-normalisation).

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

The QR is also deliberately large. A Standard card needs 57 modules across and
an Enhanced card 61, so at the 25 mm width in `QR_RECT` each module is about
0.44 mm and 0.41 mm respectively — fine for a printer and within reach of a
phone camera. Shrinking that rectangle is the quickest way to make cards
unscannable.

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
code again, recovering the portrait through the homography, rejecting a
forgery, and the Enhanced path end to end (signed face code, printed portrait
re-captured, holder accepted, different person rejected). 42 checks.

Command-line tests cover the pieces that do not:

```bash
node tools/phash-selftest.mjs     # hash stability, tolerance, discrimination
node tools/payload-selftest.mjs   # signing, encoding, tamper detection, MV2/MV3
node tools/facecode-selftest.mjs  # face code projection, then the real models on sample portraits
```

Other scripts:

```bash
node tools/make-keypair.mjs       # generate a BLS12-381 issuer keypair
node tools/make-samples.mjs       # regenerate the sample portraits
node tools/make-card.mjs          # regenerate the sample cards, including card-enhanced.png
node tools/calibrate-facecode.mjs /path/to/lfw   # recompute the face code mean and threshold
node tools/analyse-facecode.mjs /path/to/lfw     # float vs binary, 128 vs 256 bits, whitening
```

The face tools run TensorFlow.js on its pure-JavaScript CPU backend
(`tools/node-faceapi.mjs`), so they need no native addon, just patience:
calibration over 1,100 LFW faces takes about 40 minutes.

`package.json` exists only so Node treats these `.js` modules as ES modules.
There are no dependencies to install.

## Layout

```
SPECIFICATION.md    full technical specification
index.html          overview
issuer.html         issuing UI          js/issuer.js
scanner.html        verifying UI        js/scanner.js
tests.html          pipeline tests      js/tests.js
js/card.js          card geometry, portrait normalisation, homography
js/phash.js         the pHash DCT hash
js/payload.js       schema (MV2, MV3), validation, signing, QR encode and decode
js/facecode.js      MV3 face code: model loading, embedding, projection, distance
js/facecode-params.js  calibrated mean and threshold (generated)
js/issuer-key.js    the demonstration issuing authority
js/lib/             vendored third-party code, see js/lib/README.md
models/             face-api weights, loaded only for Enhanced cards
tools/              Node scripts: tests, keypairs, sample generation, calibration
samples/            portraits and ready-made cards
```

## What this is not

A working demonstration, not a deployable identity system. The gaps are worth
stating plainly:

- **The signing key is in this repository.** Anyone can mint a card the bundled
  scanner accepts. A real issuer keeps that key in an HSM and never exports it.
- **No revocation.** The expiry date closes part of this gap — an out-of-date
  card is refused offline, because the date is inside the signature and cannot be
  edited. It does nothing for a card reported stolen the day after it was issued,
  which still verifies perfectly. That needs a status check, which necessarily
  means being online.
- **On Standard cards, the portrait check compares a photograph to a
  photograph.** It confirms the picture on the card is the signed one, not that
  the person holding the card is the person in the picture. Enhanced cards add
  that check, but step 3 has **no liveness detection**: holding up a good photo
  of the cardholder will pass it. A staffed counter, where the operator sees a
  real person, is the intended setting.
- **The face model was not trained on Maldivian faces**, and the threshold was
  calibrated on LFW, which skews towards Western public figures. Error rates
  for the actual population must be measured before relying on the Enhanced
  tier.
- **A perceptual hash is a similarity measure, not a cryptographic one.** It is
  designed to survive re-photographing, which means it tolerates change by
  construction. Treat it as a tamper check, not a proof of identity.
- **Nothing is encrypted.** Anyone who scans the card reads every field —
  exactly as they could by looking at it. Whether a home address belongs in a
  machine-readable code that any passer-by can scan is a policy question this
  repository does not answer.

## Credits

- [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes) — the
  BLS-signed QR approach this is built on
- [Noble BLS12-381](https://github.com/paulmillr/noble-bls12-381) — signing
- [LZString](https://pieroxy.net/blog/pages/lz-string/) — payload compression
- [Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) — writing codes
- [jsQR](https://github.com/cozmo/jsQR) — reading codes
- [pHash](https://www.phash.org) — the perceptual hash algorithm
- [face-api](https://github.com/vladmandic/face-api) on
  [TensorFlow.js](https://www.tensorflow.org/js) — face detection and embeddings
- [Labeled Faces in the Wild](https://vis-www.cs.umass.edu/lfw/) — calibration
  of the face code mean and threshold

## Licence

MIT. Vendored dependencies keep their own licences; see `js/lib/README.md`.
