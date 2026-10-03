# Maldives Verifiable Digital ID — Technical Specification

| | |
| --- | --- |
| Schema versions | `MV2` (Standard), `MV3` (Enhanced) |
| Status | Demonstration. Normative for this repository; not a ratified national standard |
| Reference implementation | `js/card.js`, `js/phash.js`, `js/payload.js`, `js/facecode.js`, `js/facecode-params.js` |
| Companion documents | [README.md](README.md) (overview), `proposal.html` (policy), `js/lib/README.md` (vendored code) |

This document specifies everything a second, independent implementation needs to
issue cards that this verifier accepts, or to verify cards this issuer
produces: the card layout, the portrait normalisation, both perceptual
templates, the signed message, the signature scheme, the barcode encoding, the
verification procedure and the calibration behind the thresholds. Where the
reference implementation and this document disagree, that is a bug in one of
them.

## Contents

1. [Conventions](#1-conventions)
2. [System overview](#2-system-overview)
3. [Card layout](#3-card-layout)
4. [Portrait normalisation](#4-portrait-normalisation)
5. [Photo hash](#5-photo-hash)
6. [Face code (MV3)](#6-face-code-mv3)
7. [Signed message](#7-signed-message)
8. [Signature](#8-signature)
9. [Barcode encoding](#9-barcode-encoding)
10. [Issuance procedure](#10-issuance-procedure)
11. [Verification procedure](#11-verification-procedure)
12. [Face code calibration](#12-face-code-calibration)
13. [Measured performance](#13-measured-performance)
14. [Versioning and change control](#14-versioning-and-change-control)
15. [Security considerations](#15-security-considerations)
16. [Privacy considerations](#16-privacy-considerations)
17. [Test vectors](#17-test-vectors)
18. [Test suites and tools](#18-test-suites-and-tools)
19. [References](#19-references)

---

## 1. Conventions

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are
used as in RFC 2119.

- **Issuer**: produces and signs cards. In this repository, `issuer.html` with
  `js/issuer.js`.
- **Verifier**: reads and judges cards. In this repository, `scanner.html` with
  `js/scanner.js`.
- **Hex**: lowercase hexadecimal, `[0-9a-f]`, no prefix or separators, unless
  stated otherwise. Issuers MUST emit lowercase. Verifiers MUST reject photo
  hashes and face codes that are not lowercase hex of the exact length.
- **Greyscale (luma)**: `Y = 0.299·R + 0.587·G + 0.114·B` on 8-bit sRGB channel
  values, with no gamma linearisation. Where a stored 8-bit value is required it
  is rounded to the nearest integer (canvas `ImageData` does this implicitly).
- **mm**: millimetres on the physical card face, measured from its top-left
  corner, x to the right, y down.
- **Dates**: ISO 8601 calendar dates `YYYY-MM-DD`, interpreted in UTC.
- All integer arithmetic described as 32-bit is unsigned modulo 2³² unless
  stated otherwise.

## 2. System overview

A card carries six printed identity fields, a greyscale portrait and a QR code.
The QR code carries the same fields, a perceptual hash of the portrait and, on
Enhanced cards, a binarised face embedding, all covered by one BLS12-381
signature from the issuing authority.

```
 Issuer                                         Verifier (offline)
 ──────                                         ──────────────────
 fields ─┐                                      QR ──► decode ──► parse ──► verify signature (pinned key)
 photo ──┼► canonical portrait (300×400 grey)                                     │
         │      ├─► photo hash (64-bit pHash) ─┐                                  ▼
         │      └─► face code (128-bit, MV3) ──┤                            expiry check
         └──────────────────────────────────── ┼► message ─► BLS sign            │
                                               │      └─► LZString ─► QR    photo of card ─► homography
 card = printed fields + portrait + QR ◄───────┘                              ─► portrait ─► pHash ─► Hamming ≤ 12
                                                                         (MV3) live face ─► face code ─► Hamming ≤ 34
```

The verifier trusts exactly one thing: the issuer's public key, configured
out of band. It needs no network connection.

Assurance levels:

| Level | Prefix | Establishes |
| --- | --- | --- |
| Standard | `MV2` | Fields were issued by the key holder and are unaltered; the card is in date; the printed portrait is the one that was signed |
| Enhanced | `MV3` | All of the above; additionally, the person presenting the card resembles the face that was signed |

## 3. Card layout

The card face is ISO/IEC 7810 ID-1, **85.6 × 54 mm**. Two rectangles are fixed
(`js/card.js`) and are the only geometry the verifier relies on:

| Element | x | y | width | height | Notes |
| --- | --- | --- | --- | --- | --- |
| `PORTRAIT_RECT` | 5 | 14 | 19.5 | 26 | 3:4, holds the canonical portrait scaled to fit exactly |
| `QR_RECT` | 56.5 | 14 | 25 | 25 | The QR **symbol** boundary, excluding the quiet zone |

- The QR symbol MUST fill `QR_RECT` exactly, edge to edge, with no built-in
  border (the reference issuer draws it with `drawCanvas(8, 0, …)`).
- At least **2.5 mm** around `QR_RECT` (`QR_QUIET_ZONE`) MUST be blank and
  light. ISO/IEC 18004 asks for 4 modules, about 1.7 mm at these sizes.
- The QR MUST be printed with dark modules on a light background
  (non-inverted). The camera path does not attempt inverted decoding.
- The portrait MUST be printed as the exact canonical raster of §4.1, stretched
  to `PORTRAIT_RECT` without cropping, borders or overlays.
- All other layout (field labels, typography, colours, the issuer name, the
  tier mark) is presentation only and MAY vary.

`applyCardGeometry()` publishes both rectangles to CSS custom properties, so the
printed card and the verifier's geometry come from one set of numbers. Any
change to either rectangle changes where the verifier looks for the portrait
and MUST be treated as a layout version change (§14).

Resulting QR module sizes, at 25 mm:

| Payload | Encoding | Symbol | Modules | mm per module |
| --- | --- | --- | --- | --- |
| MV2 | binary (default) | version 10 | 57 | 0.44 |
| MV3 | binary (default) | version 11 | 61 | 0.41 |
| MV2 | URL-safe text | version 12 | 65 | 0.38 |
| MV3 | URL-safe text | version 13 | 69 | 0.36 |

Versions depend on the compressed length of the actual field values; the
figures are for the test vectors in §17.

## 4. Portrait normalisation

Both the issuer and the verifier reduce every portrait to the same raster
before computing anything from it. The photo hash and face code are meaningful
only between rasters produced this way.

### 4.1 Canonical portrait

- Size **300 × 400** pixels (`PORTRAIT_PIXELS`), aspect 3:4, matching
  `PORTRAIT_RECT`.
- Greyscale: each pixel's R, G and B are set to the luma `Y` (§1), alpha 255.
- Produced by `canonicalPortrait(source, crop)`: the crop rectangle of the
  source image is drawn into the 300 × 400 canvas with image smoothing enabled
  at quality `high`, then converted to greyscale.

At issuance the crop is chosen by the operator in the issuer UI (constrained to
3:4); the default is `centreCrop()`, the largest centred 3:4 rectangle.

The canonical portrait is the single artefact that is printed, hashed (§5) and,
for MV3, embedded (§6).

### 4.2 Recovery from a photograph of the card

The verifier recovers the canonical portrait from a photograph of the whole
card without operator alignment (`portraitFromCardPhoto(frame, location)`):

1. Locate the QR symbol with jsQR. Its `location` gives the symbol's four outer
   corners in frame pixels: top-left, top-right, bottom-right, bottom-left. jsQR
   orders them by finder patterns, so card rotation is handled.
2. Compute the homography `H` from the corners of `QR_RECT` (mm, clockwise from
   top-left) to those four frame points:
   - for each pair `(x, y) → (X, Y)` add the rows
     `[x, y, 1, 0, 0, 0, −xX, −yX | X]` and `[0, 0, 0, x, y, 1, −xY, −yY | Y]`;
   - solve the 8 × 8 system by Gaussian elimination with partial pivoting; a
     pivot with magnitude below 10⁻¹² means degenerate input and recovery fails;
   - `H = [h0 … h7, 1]`, row-major.
3. For each output pixel `(u, v)`, `u ∈ [0, 300)`, `v ∈ [0, 400)`, sample the
   pixel centre:
   - `mmX = 5 + ((u + 0.5) / 300) · 19.5`
   - `mmY = 14 + ((v + 0.5) / 400) · 26`
   - `(X, Y) = H(mmX, mmY)` with the projective divide; if `|w| < 10⁻¹²` or
     the point lies outside `[0, width) × [0, height)` the pixel is black and
     counts as unsampled;
   - otherwise bilinearly interpolate R, G and B (neighbour indices clamped to
     the frame) and store the luma.
4. If fewer than **70%** of output pixels were sampled, recovery fails. A hash
   of a mostly black raster is worse than none.

The camera path downsamples frames to at most **1280 pixels wide**
(`MAX_SCAN_WIDTH`) before decoding; corners and sampling then refer to the
downsampled frame. Uploaded images are treated the same way.

### 4.3 Portrait-only input

A verifier MAY accept an image of the portrait alone (no card geometry). It is
normalised with `canonicalPortrait(image, centreCrop(width, height))`. This path
exists for diagnosis; it trusts the operator to supply the right picture.

## 5. Photo hash

A 64-bit perceptual hash of the canonical portrait (`js/phash.js`), a port of
`ph_dct_imagehash` from pHash 0.9.6 with two deliberate deviations noted below.

### 5.1 Algorithm

Input: any RGBA raster (in practice the 300 × 400 canonical portrait).

1. **Luma.** `L = 0.299·R + 0.587·G + 0.114·B` per pixel, as a float (not
   rounded).
2. **Mean filter.** A 7 × 7 box mean (radius 3), implemented separably:
   horizontal pass then vertical pass, each averaging 7 samples, with edge
   samples replicated (indices clamped). *Deviation:* pHash sums with a kernel
   of ones; averaging scales every DCT coefficient by the same constant, so the
   median comparison is unchanged.
3. **Resample to 32 × 32** by area averaging. For destination pixel
   `(dx, dy)` the source footprint is `[dx·sx, (dx+1)·sx) × [dy·sy, (dy+1)·sy)`
   with `sx = W/32`, `sy = H/32`; each source pixel contributes its overlap
   area as weight. *Deviation:* pHash uses CImg's nearest-neighbour resize,
   which jitters under sub-pixel shifts.
4. **DCT.** With the pHash basis matrix `C` (32 × 32, row-major):
   - `C[0][x] = 1/√32`
   - `C[y][x] = √(2/32) · cos(π/64 · y · (2x + 1))` for `y ≥ 1`
   - `D = C · I · Cᵀ`, where `I` is the 32 × 32 image with rows indexed by y.
5. **Coefficients.** Take `D[y][x]` for `y = 1..8`, `x = 1..8` (skipping the DC
   row and column), in row-major order: coefficient index
   `i = (y − 1)·8 + (x − 1)`, `i ∈ [0, 64)`.
6. **Median.** Sort the 64 values numerically; the median is the mean of the
   32nd and 33rd smallest (CImg's even-count median).
7. **Bits.** Bit `i` is 1 when coefficient `i` is strictly greater than the
   median.

### 5.2 Encoding

The 64 bits form an unsigned integer `h = Σ bitᵢ · 2ⁱ`, so **coefficient 0 is
the least significant bit**. `h` is written as 16 lowercase hex digits, most
significant first, zero-padded.

> Note the bit order differs from the face code (§6.4), where bit 0 is the most
> significant bit of the first hex digit. Each is internally consistent; do
> not mix them.

### 5.3 Comparison

Distance is the Hamming distance between the two 64-bit values: popcount of the
XOR, `0..64`. The verifier accepts a portrait when the distance is at most the
threshold.

| Parameter | Value |
| --- | --- |
| Default threshold | **12** bits |
| Operator range | 0–32 |
| Typical genuine, card flat or on screen | 0 |
| Typical genuine, angled photo with noise and brightness shift | 8 |
| Different person (bundled fixtures) | 34–36 |

Above about 20 the check stops discriminating meaningfully.

## 6. Face code (MV3)

A 128-bit locality-sensitive hash of a face embedding, carried only on MV3
cards (`js/facecode.js`). It lets a verifier compare the person presenting the
card with the face that was signed, using the same Hamming-distance comparison
as the photo hash. It is not a cryptographic hash: two captures of one face
never produce identical embeddings.

### 6.1 Pinned components

Every item in this table is bound to the `MV3` prefix. Changing any of them
changes the codes that genuine faces produce, and MUST be shipped as a new
schema version (§14).

| Component | Value |
| --- | --- |
| Library | [vladmandic/face-api](https://github.com/vladmandic/face-api) **1.7.15**, `dist/face-api.esm.js` (bundles TensorFlow.js 4.22.0) |
| Detector | `tiny_face_detector_model` |
| Landmarks | `face_landmark_68_model` |
| Embedding | `face_recognition_model` (ResNet-34-style, 128-d output) |
| Preprocessing | greyscale, 25% neutral-grey padding (§6.2) |
| Detector input sizes | 416, 320, 512, 224, 608, in that order |
| Detector score threshold | 0.2 |
| Population mean | `FACE_MEAN`, 128 values in `js/facecode-params.js` |
| Projection seed | `0x4d5633` |
| Code length | 128 bits, 32 hex digits |
| Bit packing | MSB-first per hex digit (§6.4) |

Model files as shipped in `models/`:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `tiny_face_detector_model.bin` | 193,321 | `b7503ce7df31039b1c43316a9b865cab6a70dd748cc602d3fa28b551503c3871` |
| `tiny_face_detector_model-weights_manifest.json` | 3,219 | `5d1af4849ac48d5b985f4a9b16010c512353ddd6fcc63d50fd0bc9e9e64296e5` |
| `face_landmark_68_model.bin` | 356,840 | `4611ef65c87d836d03d684b30eec4d195d8b219fa1dd58fc58945831c6b9299b` |
| `face_landmark_68_model-weights_manifest.json` | 8,485 | `ca4886639f86e99b39fed0c155f81b63317225773bd9616716e887b0153389c9` |
| `face_recognition_model.bin` | 6,444,032 | `b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589` |
| `face_recognition_model-weights_manifest.json` | 19,615 | `cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b` |
| `js/lib/face-api.esm.js` | — | `14f0e9813f6d9f14a9cdafb6543a74835ebb13085090e2942310a7a737f55d9a` |

### 6.2 Face description

`describeFace(pixels)`, input an RGBA raster `W × H`:

1. **Greyscale.** `Y = round(0.299·R + 0.587·G + 0.114·B)`, replicated into
   three channels, as an `int32` tensor of shape `[H, W, 3]`. Colour never
   reaches the model: the printed portrait is greyscale, so live captures are
   reduced the same way.
2. **Pad.** `padX = round(0.25·W)`, `padY = round(0.25·H)` on each side, filled
   with the constant **128**. The tiny detector misses faces that fill the
   frame, which an ID portrait does by design; padding gives it context.
3. **Detect, align, embed.** For each detector input size in
   `[416, 320, 512, 224, 608]`:
   `detectSingleFace(padded, TinyFaceDetectorOptions({inputSize, scoreThreshold: 0.2})).withFaceLandmarks().withFaceDescriptor()`.
   `detectSingleFace` keeps the highest-scoring detection; face-api then aligns
   the face from the 68 landmarks and computes the 128-float descriptor. The
   first input size that yields a result wins; later sizes are not tried.
4. If no size yields a face, there is **no code**. The issuer MUST NOT sign an
   MV3 card without one; the verifier reports that no face was found.

The returned box is shifted back by `(padX, padY)` into input coordinates; it is
for display only.

### 6.3 Projection

Let `d` be the descriptor (128 float32 values, widened to float64) and `μ` the
population mean `FACE_MEAN` (float64, as published to six decimal places).

1. **Centre.** `c[j] = d[j] − μ[j]`, `j ∈ [0, 128)`. Raw descriptors share a
   large common component, which crowds every face into a narrow cone;
   centring is what makes different people differ by many bits (§13.1).
2. **Hyperplanes.** A 128 × 128 matrix `P` of ±1 values, generated row-major
   from the mulberry32 PRNG seeded with `0x4d5633`: the `k`-th output
   (`k = 128·i + j`, starting at `k = 0`) gives `P[i][j] = +1` if the output is
   odd, otherwise `−1`. Row `i` is the hyperplane for bit `i`.

   mulberry32, with all operations on unsigned 32-bit integers and `imul` the
   low 32 bits of the product:

   ```
   state = seed
   next():
       state = state + 0x6D2B79F5
       t = state
       t = imul(t XOR (t >> 15), t OR 1)
       t = t XOR (t + imul(t XOR (t >> 7), t OR 61))
       return t XOR (t >> 14)
   ```

   ±1 integers rather than Gaussian draws make the matrix reproducible bit for
   bit in any language.
3. **Sign.** `bitᵢ = 1` if `Σⱼ P[i][j] · c[j] > 0`, else `0`. A dot product of
   exactly zero gives 0. Accumulate in float64.

### 6.4 Encoding

Bits are packed four per hex digit, **most significant first**: hex digit `n`
(`n ∈ [0, 32)`) has value `8·bit(4n) + 4·bit(4n+1) + 2·bit(4n+2) + bit(4n+3)`.
So bit 0 (hyperplane 0) is the high bit of the first character. The result is
32 lowercase hex digits.

### 6.5 Comparison

Distance is the number of differing bits, `0..128`: per hex digit, popcount of
the XOR of the two nibbles, summed. Expected distance between unrelated faces
is about 64 (half the bits), and the fraction of differing bits approximates
θ/π for the angle θ between the two centred embeddings.

| Parameter | Value | Source |
| --- | --- | --- |
| Default threshold | **34** bits (`FACE_MATCH_THRESHOLD`) | 0.1% false accept on LFW (§12) |
| Loose threshold | 40 bits | ~1% false accept on LFW |
| Operator range | 0–64 | |

A distance at or below the threshold is a match.

### 6.6 Inputs at issuance and verification

- **Issuance**: the canonical portrait (§4.1), the same raster that is printed
  and hashed. The signed code therefore describes the photograph on the card.
- **Verification, person**: a front-camera frame (requested at 1280 × 720,
  user-facing) or an uploaded photo, downsampled to at most **960 pixels wide**
  (`MAX_BEARER_WIDTH`). No portrait normalisation is applied; the padding and
  detector ladder handle framing.
- **Verification, card portrait**: the portrait recovered by §4.2. This
  compares the printed face with the signed code. It shows the code surviving
  print and capture and detects a swapped portrait, but says nothing about who
  is holding the card.

### 6.7 Numerical determinism

The projection (§6.3–6.4) is exact given a descriptor. The descriptor itself
comes from floating-point inference, and TensorFlow.js backends (WebGL, CPU)
round differently, so the same image can yield descriptors that differ
slightly, and bits whose dot product is near zero can flip. Verifiers MUST
compare by distance and MUST NOT require equality. The reference browser
implementation tries WebGL and falls back to CPU; the Node tools use CPU.

## 7. Signed message

### 7.1 Fields

| # | Key | Label | Max length | Issuer validation |
| --- | --- | --- | --- | --- |
| 1 | `idNumber` | ID Card Number | 16 | Required; `^[A-Za-z][0-9]{6}$` (e.g. `A123456`) |
| 2 | `name` | Name | 60 | Required |
| 3 | `sex` | Sex | 1 | `M` or `F` |
| 4 | `dob` | Date of Birth | 10 | Strict date (§7.3); not in the future |
| 5 | `expiry` | Expiry Date | 10 | Strict date; not already expired at issuance |
| 6 | `address` | Permanent Address | 80 | Required, single line |

Lengths are counted in UTF-16 code units after sanitisation. Field values are
free Unicode text (Thaana included) subject to §7.2.

### 7.2 Sanitisation

`#` separates fields and is never escaped. Every field value MUST be
sanitised before signing, in this order:

1. Replace each run of `#`, CR, LF or TAB with a single space.
2. Replace each run of whitespace (`\s`, Unicode-aware as in ECMAScript) with a
   single space.
3. Trim leading and trailing whitespace.

The issuer signs exactly the sanitised values. The verifier does not
re-sanitise; it splits on `#`.

### 7.3 Dates

A date is valid when it matches `^\d{4}-\d{2}-\d{2}$` and names a real
calendar day (no rollover: `2025-02-30` is invalid). It denotes 00:00:00.000
UTC on that day.

A card is **valid through the end of its expiry day in UTC**:
`expired ⇔ now > midnight(expiry) + 86 400 000 ms − 1`.
`daysRemaining = ceil((endOfDay − now) / 86 400 000)`.

### 7.4 Grammar

```abnf
barcode-data = message "#" signature
message      = mv2 / mv3
mv2          = "MV2" fields "#" photo-hash
mv3          = "MV3" fields "#" photo-hash "#" face-code
fields       = 6( "#" field )            ; idNumber, name, sex, dob, expiry, address
field        = *( %x01-22 / %x24-10FFFF ) ; any character except "#" (and NUL), after §7.2
photo-hash   = 16LHEX
face-code    = 32LHEX
signature    = 192LHEX                   ; 96-byte compressed G2 point
LHEX         = %x30-39 / %x61-66         ; 0-9 a-f
```

MV2 messages therefore have 8 `#`-separated parts and MV3 messages 9; barcode
data adds one more for the signature.

### 7.5 Parsing

A verifier MUST:

1. Split the barcode data on `#`; the last part is the signature, the rest
   rejoined with `#` is the message.
2. Split the message on `#`. The first part MUST be exactly `MV2` or `MV3`;
   anything else is rejected, not guessed at. (`MV1` placed a phone number
   where `MV2` has the expiry; positional fields make silent reinterpretation
   dangerous.)
3. Require exactly 8 parts for `MV2`, 9 for `MV3`.
4. For `MV3`, require the last part to be a valid face code; then require the
   next-to-last (or, for `MV2`, the last) part to be a valid photo hash.
5. Assign the remaining six parts to the fields in table order.

The version prefix is inside the signature, so an MV3 card cannot be presented
as MV2 by deleting its face code: the shortened message no longer verifies.

## 8. Signature

### 8.1 Scheme

BLS signatures over BLS12-381, **minimal-pubkey-size** variant (public keys in
G1, signatures in G2), **basic scheme**, as in the IETF BLS signature draft:

| Item | Value |
| --- | --- |
| Hash-to-curve suite | `BLS12381G2_XMD:SHA-256_SSWU_RO_` |
| Domain separation tag | `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_` |
| Secret key | 32 bytes, big-endian scalar, non-zero and below the group order *r* |
| Public key | 48 bytes, compressed G1 point (96 hex) |
| Signature | 96 bytes, compressed G2 point (192 hex) |
| Signed bytes | the UTF-8 encoding of the message string (§7.4), nothing else |

Verification checks `e(pk, H(m)) = e(G1, σ)`. Signing is deterministic: the
same key and message always give the same signature (§17.4).

The reference implementation is `noble-bls12-381` as vendored in
`js/lib/noble-bls.js`; `signMessage()` hex-encodes the UTF-8 bytes and passes
them to `nobleBLS.sign`, which decodes the hex before hashing to the curve.

A malformed signature or key MUST be treated as a failed verification, never
as an error that bypasses the check.

### 8.2 Keys

- `tools/make-keypair.mjs` generates a keypair. `randomSecretKey()` draws 32
  random bytes and reduces the first byte modulo `0x40`, which keeps the value
  below *r*.
- The demonstration authority (`js/issuer-key.js`) is
  "Department of National Registration" with public key
  `972d56fa0c5031dfbd48f186ab17dab12c773bcbc4d49c67ce45792f314b53a461d57d59967941876d15736b8b8dd529`.
  Its secret key is committed to the repository for the demo (§15.1).
- The verifier pins one trusted public key (editable in the UI, defaulting to
  the authority's). The payload carries no key identifier. `TRUSTED_KEYS` in
  `js/issuer-key.js` is reserved for key rotation (a verifier would try each
  key in turn); the current scanner does not use it.

## 9. Barcode encoding

### 9.1 Compression

The barcode data string (§7.4) is compressed with
[LZString](https://pieroxy.net/blog/pages/lz-string/). Two modes exist:

| Mode | Issuer call | QR content | Notes |
| --- | --- | --- | --- |
| **binary** (default) | `LZString.compressToUint8Array(data)` | byte-mode segment of the raw bytes | Smallest |
| **text** | `LZString.compressToEncodedURIComponent(data)` | text segment of the URL-safe ASCII string | ~⅓ larger; survives readers that mangle raw bytes |

Implementations in other languages MUST use an LZString port that is
byte-compatible with these two functions; the format is LZString's own, not
DEFLATE.

### 9.2 QR symbol

Generated by Nayuki's QR Code generator (`QrCode.encodeBinary` or
`QrCode.encodeText`):

- Error correction level **L** (low) requested. The generator MAY boost to a
  higher level when it fits in the same version; none of the test vectors are
  boosted.
- Smallest version that fits; automatic mask selection.
- Rendered without border into `QR_RECT` (§3).

Level L is chosen deliberately: the payload is large and the card is printed
at a known size, so module size matters more than redundancy.

### 9.3 Decoding

The verifier uses jsQR (camera: `inversionAttempts: 'dontInvert'`; uploads:
`'attemptBoth'`). It then tries, in order, and accepts the first result that
begins with `MV2#` or `MV3#`:

1. `LZString.decompressFromUint8Array(binaryData)` (binary mode);
2. `LZString.decompressFromEncodedURIComponent(data)` (text mode);
3. `data` unchanged (plain, uncompressed payloads).

The verifier detects the mode; it is not told. Readers sometimes hand byte-mode
data back as text, which is why both are attempted.

## 10. Issuance procedure

1. Collect the six fields; sanitise (§7.2) and validate (§7.1). Reject on any
   error.
2. Load the photograph; the operator frames a 3:4 crop. Produce the canonical
   portrait (§4.1).
3. Compute the photo hash (§5) of the canonical portrait.
4. **Enhanced only:** compute the face code (§6) of the canonical portrait.
   If no face is found, signing MUST be blocked.
5. Build the message: `MV2#…#photoHash`, or `MV3#…#photoHash#faceCode` when a
   face code is supplied (`buildMessage`). Supplying a face code is what
   selects MV3.
6. Sign the UTF-8 bytes of the message (§8). Append `#` and the signature.
7. Compress and encode as a QR symbol (§9).
8. Print the card: fields, the canonical portrait in `PORTRAIT_RECT`, the QR in
   `QR_RECT` with its quiet zone (§3).

## 11. Verification procedure

### 11.1 Steps

1. **Decode** the QR (§9.3). Failure: *not an ID card*.
2. **Split and parse** (§7.5). Failure: *malformed payload*. Parsing precedes
   the signature check so the error is specific; parsed values are not trusted
   until step 3 passes.
3. **Verify the signature** against the pinned public key (§8). Every later
   result is meaningful only if this passes.
4. **Expiry** (§7.3) from the signed `expiry` field.
5. **Portrait.** Recover the portrait from the same image when it contains the
   whole card (§4.2), or from a second photo of the card, or (diagnostic) from
   a portrait-only image (§4.3). Compute its photo hash and compare (§5.3).
6. **Bearer (MV3 only, optional).** Compute a face code from the person (§6.6)
   and compare with the signed face code (§6.5). The face models are loaded
   only at this point, so verifying an MV2 card never downloads them.

The verifier MUST NOT re-validate field formats beyond the expiry date: the
signature already establishes that the issuer accepted them.

### 11.2 Verdict

Exactly one overall verdict is shown, chosen by the first matching row:

| # | Condition | Verdict | Kind |
| --- | --- | --- | --- |
| 1 | Signature invalid, or decode/parse failed | Card rejected | fail |
| 2 | Expired | Card expired | fail |
| 3 | Expiry not a valid date | Card rejected | fail |
| 4 | Portrait captured and photo hash distance > threshold | Portrait does not match | fail |
| 5 | Bearer compared from a person and distance > threshold | Person does not match the card | fail |
| 6 | Bearer compared from the card portrait and distance > threshold | Portrait does not match the face code | fail |
| 7 | No portrait captured yet | Signature valid (or Person matches), portrait not yet checked | warn |
| 8 | Otherwise, bearer matched from a person | Card and holder verified | pass |
| 9 | Otherwise | Card verified | pass |

Rules:

- Expiry outranks the portrait. A signature only says a card was issued; an
  expired card is genuine and unusable at once, and a matching photo does not
  change that.
- "Card and holder verified" requires a bearer comparison from a **person**. A
  card-portrait comparison alone never yields it.
- A passing verdict with ≤ **90** days to expiry (`EXPIRY_WARNING_DAYS`) is
  downgraded to *warn* with the remaining days stated.
- An MV3 card that passes rows 1–4 without a bearer check is *Card verified*,
  with a note that step 3 can also confirm the person.

## 12. Face code calibration

`FACE_MEAN` and `FACE_MATCH_THRESHOLD` are generated by
`tools/calibrate-facecode.mjs`. The procedure is deterministic given the
dataset.

### 12.1 Data and split

Dataset: [Labeled Faces in the Wild](https://vis-www.cs.umass.edu/lfw/) (LFW),
the standard 250 × 250 JPEG release, extracted as one folder per person.

1. List person folders sorted by name (`localeCompare`); list each folder's
   `.jpg` files sorted.
2. **Mean set**: people with exactly one image; take **500** evenly spaced
   (`list[floor(i · n/500)]`). Their images estimate `μ`.
3. **Evaluation set**: people with two or more images; take **300** evenly
   spaced. Disjoint from the mean set by construction.
4. Describe every selected image with §6.2 (images where no face is found are
   dropped).
5. `μ[j]` = arithmetic mean of the mean-set descriptors, written to six
   decimals.
6. **Genuine pairs**: each evaluation person's first two images (300 pairs).
   **Impostor pairs**: the first image of every pair of distinct evaluation
   people (300·299/2 = 44,850 pairs).
7. **Threshold** = the largest `t ∈ [0, 128]` such that the fraction of
   impostor pairs with distance ≤ `t` is at most **0.1%**. The loose threshold
   uses 1%. The equal error rate is reported at the integer `t` where false
   reject and false accept are closest.

The script prints the uncentred baseline beside the centred result and writes
`js/facecode-params.js`. Only aggregates are written; no LFW image or
per-subject descriptor is committed.

### 12.2 Reproducing

Prerequisites: Node 18 or later; macOS `sips` or ImageMagick `magick` (JPEG is
decoded to BMP because the project has no dependencies); an extracted LFW.

```bash
node tools/calibrate-facecode.mjs /path/to/lfw    # ~40 min first run, seconds after
node tools/analyse-facecode.mjs /path/to/lfw      # comparison table in §13.1
```

Intermediate files go to `/path/to/lfw-mv3-cache/` (`bmp/` and
`descriptors.json`, descriptors rounded to six decimals). Deleting the cache
forces a full rerun.

A national deployment SHOULD recompute `μ` and the threshold on its own
enrolment photographs (§14).

## 13. Measured performance

### 13.1 LFW

Same split as §12.1.

| | Uncentred | Centred (shipped) |
| --- | --- | --- |
| Median distance, same person | 12 bits | 33 bits |
| Median distance, different people | 22 bits | 64 bits |
| Equal error rate | 13.1% | 6.7% |
| True accept at 0.1% false accept | 21% | 56.7% (threshold 34, measured FAR 0.082%) |
| True accept at ~1% false accept | 40% | 75.7% (threshold 40, measured FAR 0.76%) |

Ceiling and alternatives (`tools/analyse-facecode.mjs`; thresholds here accept
strictly below the impostor quantile, so values differ slightly from the
calibration's inclusive rule):

| Representation | TAR @ 1% FAR | TAR @ 0.1% FAR | EER |
| --- | --- | --- | --- |
| Float descriptor, Euclidean | 92.0% | 83.3% | 5.3% |
| Float descriptor, centred cosine | 91.3% | 80.0% | 5.3% |
| **128-bit code (shipped)** | 75.7% | 56.7% | 6.7% |
| 128-bit code, whitened | 77.7% | 55.7% | 6.8% |
| 256-bit code | 85.0% | 64.7% | 5.7% |
| 256-bit code, whitened | 85.0% | 67.7% | 6.2% |

Most of the shortfall from a perfect score is the embedding model; going to 256
bits recovers part of the binarisation loss at the cost of 32 more hex
characters in the QR.

LFW same-person pairs are often years apart with different pose and lighting,
which is harder than matching an ID photo against its holder at a counter.

### 13.2 Bundled samples

| Case | Face code distance |
| --- | --- |
| Same portrait: darkened, washed out, blurred, downsampled, noisy, shifted | 0–9 |
| Card printed, then photographed at an angle with noise (browser test) | 12–17 |
| Original colour photo vs the signed greyscale portrait | 6–8 |
| `portrait-1.jpg`, a different woman | 50–56 |
| `portrait-3.jpg` vs `portrait-4.jpg`, two more different women | **32–38** |

The last row falls partly inside the default threshold. face-api's own
Euclidean distances for those faces are 0.46–0.56, under its usual 0.6
"same person" rule, so the model rather than the binarisation fails to
separate them. **The Enhanced tier MUST NOT be relied on operationally until
measured on Maldivian enrolment photographs**, and probably moved to a stronger
embedding model under a new schema version.

### 13.3 Size and speed

| Item | Value |
| --- | --- |
| MV2 barcode data | 302 characters → 270 bytes (binary) |
| MV3 barcode data | 335 characters → 290 bytes (binary) |
| Face models | about 7 MB, fetched once, MV3 only |
| Embedding time | tens of milliseconds with WebGL after load; about 2 s per face on the Node CPU backend |

## 14. Versioning and change control

The schema prefix identifies the field set **and** every algorithm whose
output is signed. A new prefix (e.g. `MV4`) is REQUIRED for any change to:

- the fields, their order, or their meaning;
- sanitisation or date rules that change what is signed;
- the photo hash algorithm, including the luma weights, filter, resampling,
  DCT basis, coefficient block or bit encoding;
- the canonical portrait size or greyscale conversion;
- anything in §6.1 (model, weights, preprocessing, detector settings, mean,
  seed, code length, bit packing);
- the signature scheme or DST.

Changes that do **not** need a new prefix, because they are verifier policy
and nothing signed depends on them: thresholds, the expiry warning window,
camera resolution, the verdict wording.

Card layout (§3) is not inside the signature, but verifiers locate the portrait
from it; a layout change requires verifiers to know which layout a card uses.
Tie layout changes to a new prefix unless a separate layout identifier is
introduced.

Verifiers MUST reject unknown prefixes. A verifier MAY support several
prefixes at once; each is parsed by its own rules.

## 15. Security considerations

### 15.1 Demonstration key

The signing key is committed in `js/issuer-key.js`. Anyone can mint cards the
bundled verifier accepts. A deployment MUST generate its key in a hardware
security module and never export it.

### 15.2 What the signature does and does not prove

It proves the key holder signed these exact bytes. It does not prove the card
is still valid (no revocation; §15.6), that the printed text matches the QR
(the verifier displays the signed values, and the operator SHOULD compare them
with the print), or that the portrait is the signed one (that is §5's job).

### 15.3 Portrait substitution

Copying a genuine QR onto a card with a different portrait leaves the
signature intact; the photo hash catches it (sample `card-forged.png`). pHash
is a similarity measure, not collision resistant: a determined forger can
perturb a different face's image until its hash falls within the threshold of
the signed one. MV3 raises the bar, since the forged image must then also
match the face code, and an operator looking at the card remains part of the
control.

### 15.4 Face code limits

- **No liveness.** A good photograph of the holder passes step 3. Intended for
  staffed counters.
- **Look-alikes.** At the default threshold about 1 in 1,000 unrelated LFW
  pairs is accepted; for similar faces from one population, worse (§13.2).
- **Morphing.** A portrait morphed from two people can match both. This is a
  property of all face templates; enrolment photo controls are the mitigation.
- **Adversarial images.** Embeddings can be steered by crafted perturbations.
  The face code complements the photo hash and operator inspection; it does not
  replace them.

### 15.5 Downgrade and injection

- MV3 → MV2 downgrade fails because the prefix is signed.
- Field injection is impossible because `#` cannot occur in a field and the
  part count is fixed per prefix.
- Unknown or future prefixes are rejected, never guessed.

### 15.6 Revocation

None offline. The signed expiry date bounds a card's life, but a card reported
stolen today still verifies until it expires. Revocation needs an online status
check, which SHOULD complement, never replace, the offline signature check.

### 15.7 Why the QR does not carry a URL

A QR that opens a verification website proves only that someone registered a
domain and built a page. Look-alike domains (`dnr-verify.gov.mv`,
`dnr.gov-mv.com`, homographs) are routine phishing; checking a URL character by
character is not a control, and a link fails offline. Carrying the signed
evidence in the QR and pinning the key in the verifier removes both problems.

## 16. Privacy considerations

- **Nothing is encrypted.** Anyone who scans a card reads every field, as they
  could by looking at it. Whether a home address belongs in a machine-readable
  code is a policy decision outside this specification.
- **The face code is a biometric template.** It can link one person across
  systems that use the same model, mean and seed. It is stored only on the card
  and is computed and compared on the verifying device; the reference verifier
  sends nothing over the network.
- **Templates cannot be reissued in place.** A compromised face code is
  cancelled only by issuing new cards under a different seed or mean, i.e. a
  new schema version (§14).
- Rolling out MV3 requires a privacy impact assessment and a decision on who
  may perform bearer checks.

## 17. Test vectors

All values below are produced by the reference implementation and checked
against the tools in §18.

### 17.1 mulberry32, seed `0x4d5633`

| Output | Value |
| --- | --- |
| 1 | `0x3526b261` |
| 2 | `0xaa8ba408` |
| 3 | `0x334034fa` |
| 4 | `0x15fe5e14` |

First 16 entries of hyperplane row 0, `P[0][0..15]`:

```
+1 -1 -1 -1 -1 +1 -1 -1 -1 +1 -1 -1 +1 -1 -1 +1
```

### 17.2 Projection

With `μ = FACE_MEAN` from `js/facecode-params.js` (first values
`-0.089904, 0.085640, 0.045471, -0.034830`), descriptors given as Float32Array:

| Descriptor | Face code |
| --- | --- |
| A: `d[j] = μ[j] + ((j mod 7) − 3) / 100` | `6958652c58e244ac452046e94fec1ffd` |
| B: `d[j] = μ[j] + (j = 0 ? 1 : 0)` | `d0108a297c99898460f638346f03d17b` |

Distance A–B: 67 bits. Descriptor B's code is the sign pattern of column 0 of
`P`, so its first digit `d` = `1101` reproduces `P[0][0], P[1][0], P[2][0],
P[3][0] = +1, +1, −1, +1`.

### 17.3 Images

`samples/portrait-a.rgba` is the canonical portrait used for the sample cards,
stored as two big-endian uint32 values (width 300, height 400) followed by RGBA
bytes.

| Function | Result |
| --- | --- |
| Photo hash (§5) | `290d5eb82deaf087` |
| Face code (§6), TensorFlow.js CPU backend | `af9e5dce17ac9f398df3e7ff18ce6cc2` (detector score 0.946) |

Other backends may differ from this face code by a few bits (§6.7).

### 17.4 Signed payloads

Demonstration secret key (never use outside this repository):

```
4f2a8c1d6b3e9705a1c84f2d7b6e3059c4a8d1f26b93e70582cd4a1f6b8e3d07
```

Public key:

```
972d56fa0c5031dfbd48f186ab17dab12c773bcbc4d49c67ce45792f314b53a461d57d59967941876d15736b8b8dd529
```

Fields: `A123456`, `Aishath Nasheeda Ibrahim`, `F`, `1991-04-17`,
`2036-10-03`, `Ma. Blue Heaven, Male, Maldives`.

**MV2**

```
message   (109 bytes)
MV2#A123456#Aishath Nasheeda Ibrahim#F#1991-04-17#2036-10-03#Ma. Blue Heaven, Male, Maldives#290d5eb82deaf087

signature
8ec29939551a4689c7c75b33a77a9c910f8d2791fe4a303d4dc7ca25420f04434aa8f390a92286c1812826250b6185f9127a7e021f91fe7fc044da1df43e0b1000970e554cf66bca20fe73598222d504765c626b77be6542205e46ac96a80782
```

Barcode data 302 characters; binary 270 bytes → QR version 10, ECC L; text 360
characters → version 12.

**MV3**

```
message   (142 bytes)
MV3#A123456#Aishath Nasheeda Ibrahim#F#1991-04-17#2036-10-03#Ma. Blue Heaven, Male, Maldives#290d5eb82deaf087#af9e5dce17ac9f398df3e7ff18ce6cc2

signature
b90e71dbfdf049217226e1842d9ef1ff43b9148dda9d704e71c9a3adb2dea7ef885aaff58a19783a2c65a5f96180d9df0c65280f598a3774cb610b01a5746d2c11d1dc79d0a98a38ff3ee87389decf4d5bebf6247209016e6f10cc1c55578088
```

Barcode data 335 characters; binary 290 bytes → QR version 11, ECC L; text 387
characters → version 13.

The sample cards in `samples/` are regenerated with a current expiry date, so
their signatures differ from these.

### 17.5 Negative cases

A conforming verifier MUST reject:

| Input | Stage |
| --- | --- |
| Either message above with any character of a field, photo hash or face code changed (keeping it well formed) | signature |
| The MV3 message with `MV3` changed to `MV2` and the face code removed, keeping the MV3 signature | signature |
| `MV1#…` or any other prefix | parse |
| `MV2` message with 7 or 9 parts | parse |
| Photo hash or face code with uppercase hex or wrong length | parse |
| Either payload verified against any other public key | signature |
| Valid payload with `expiry` in the past | verdict *Card expired* |

## 18. Test suites and tools

| Command | Covers |
| --- | --- |
| `tests.html` (browser) | Card rendering, real QR drawn and re-read from a synthetic angled photo, homography recovery, forgery rejection, MV3 end to end. 42 checks |
| `node tools/phash-selftest.mjs` | Photo hash stability, tolerance, discrimination. 9 checks |
| `node tools/payload-selftest.mjs` | Fields, sanitisation, dates, signing, encoding, tampering, MV2/MV3 parsing and downgrade. 41 checks |
| `node tools/facecode-selftest.mjs` | Projection determinism and packing, then the real models on sample portraits. 19 checks |
| `node tools/calibrate-facecode.mjs <lfw>` | Regenerates `js/facecode-params.js` (§12) |
| `node tools/analyse-facecode.mjs <lfw>` | Float vs binary, 128 vs 256 bits, whitening (§13.1) |
| `node tools/make-keypair.mjs` | New BLS12-381 keypair |
| `node tools/make-samples.mjs` | Sample portraits |
| `node tools/make-card.mjs` | Sample cards, including `card-enhanced.png` |

Node notes:

- `noble-bls.js` is a browser module; `tools/browser-shim.mjs` supplies `self`
  so it loads in Node.
- `tools/node-faceapi.mjs` runs face-api on the pure-JavaScript TensorFlow.js
  CPU backend with no native addon. It sets a placeholder `globalThis.document`
  (so TensorFlow.js keeps its browser platform; inputs are always tensors) and
  `globalThis.require` (for the bundle's dynamic-require shim), and loads
  weights from `models/` with `loadFromWeightMap` instead of fetching them.
- `package.json` exists only to mark the `.js` files as ES modules. There are
  no dependencies.

## 19. References

- RFC 2119, *Key words for use in RFCs to Indicate Requirement Levels*.
- IETF CFRG, *BLS Signatures* (draft-irtf-cfrg-bls-signature).
- RFC 9380, *Hashing to Elliptic Curves*.
- ISO/IEC 7810, *Identification cards — Physical characteristics* (ID-1).
- ISO/IEC 18004, *QR Code bar code symbology specification*.
- C. Zauner, *Implementation and Benchmarking of Perceptual Image Hash
  Functions*, 2010; [pHash.org](https://www.phash.org).
- M. Charikar, *Similarity Estimation Techniques from Rounding Algorithms*,
  STOC 2002 (random-hyperplane hashing).
- G. B. Huang et al., *Labeled Faces in the Wild*, UMass Amherst TR 07-49, 2007.
- [oelna/signed-qr-codes](https://github.com/oelna/signed-qr-codes),
  [noble-bls12-381](https://github.com/paulmillr/noble-bls12-381),
  [LZString](https://pieroxy.net/blog/pages/lz-string/),
  [Nayuki QR Code generator](https://www.nayuki.io/page/qr-code-generator-library),
  [jsQR](https://github.com/cozmo/jsQR),
  [face-api](https://github.com/vladmandic/face-api),
  [TensorFlow.js](https://www.tensorflow.org/js).
