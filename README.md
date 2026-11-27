# PNG Squeezer — Squeeze screenshots into the smallest PNG, 27 November 2026

[![make.fun competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun rank](https://make.fun/badge/png-squeeze-01-run-20261127/Mastomy2/png-squeeze-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun reward](https://make.fun/badge/png-squeeze-01-run-20261127/Mastomy2/png-squeeze-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG re-encoder for 1280×720 RGBA screenshots. It writes the same
pixels back as a PNG in as few bytes as it can: every pixel's R/G/B/A decodes
exactly, including fully transparent pixels' colours.

## How it works

1. **Form reduction** — per image it picks the smallest exact form: a palette
   (≤256 colours, by count or by luminance) when one fits, grey or grey+alpha
   when every pixel is grey, RGB when every pixel is opaque, RGBA otherwise,
   with a tRNS key when a single transparent value fits.
2. **Filter screen** — each row's filter is chosen among fixed filters,
   minimum-sum, fewest-distinct-pairs, and brute force (each filter weighed by
   zlib over the row after the 32 KiB before it); the winning form+filter is
   the one whose zlib level-6 stream is smallest.
3. **Optimal-parsing deflate** — the filtered bytes are compressed by a
   from-scratch deflate: a hash-chain LZ77 matcher, a greedy lazy parse that
   seeds the symbol frequencies, then a dynamic-programming optimal parse
   under iterated Huffman code lengths, emitted as one dynamic (or fixed, when
   smaller) Huffman block.

## Practice-set score

Local grade on the kit's practice set (`grade-local --driver process`):

- **717.603 / 1.000.000** (mean 717,603 points per instance), all 8 instances
  answered, deterministic (two runs byte-identical).
- v1 scored 725.726 locally but **timed out on the server** (wall budget 60 s):
  the server runs the same code slower than this machine, so v2 trades
  ~8k points for ~11 s of wall: DP updates only at length-symbol interval
  ends, the filter screen drops minsum/pairs (brute force beats pairs under
  the optimal deflate), and the LZ77 chain depth is 96 instead of 192.
- Reference points: the kit's scale compressor scores 666,7 by construction;
  zlib level 9 on the same screened data scores 701,0; the house baseline
  (fixed Paeth, no form reduction) scores ~420 on this set.
- Wall time for the whole set of 8: ~25 s on this machine (limit 60 s).

## Run it

```sh
node main.ts            # reads /input/<id>/image.png, writes /output/<id>/image.png
```

Node 22, no dependencies, no network, no clock reads: the same input always
produces the same bytes.

## Licence

MIT — see [LICENSE](LICENSE).
