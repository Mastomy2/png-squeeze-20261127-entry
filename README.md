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
2. **Filter screen** — each row's filter is chosen among fixed filters and
   brute force (each filter weighed by zlib over the row after the 32 KiB
   before it); the winning form+filter is the one whose zlib level-6 stream
   is smallest. (minsum/pairs dropped in v2: minsum never won, and brute
   force beats pairs under the optimal deflate.)
3. **Optimal-parsing deflate** — the filtered bytes are compressed by a
   from-scratch deflate: a hash-chain LZ77 matcher, a greedy lazy parse that
   seeds the symbol frequencies, then a dynamic-programming optimal parse
   under iterated Huffman code lengths, emitted as one dynamic (or fixed, when
   smaller) Huffman block.

## Practice-set score

Local grade on the kit's practice set (`grade-local --driver process`):

- **724.122 / 1.000.000** (mean 724,122 points per instance), all 8 instances
  answered, deterministic (two runs byte-identical; result_sha256
  9c776946b4ece4dadd34eeba25d351f964ebc41df3baaa050e61baf6aa156062).
- v2 scored 717.603 locally and **717.603 on the server (rank 1.154/4.924,
  prize-eligible)**; v1 scored 725.726 locally but **timed out on the
  server** (wall budget 60 s). The v2 server run measured wall_ms 84.714
  over 2 executions, i.e. ~42,4 s per run — the server runs this code ~1,73x
  slower than this machine. v3 restores chain depth 192: +6,519 points over
  v2 for ~5 s more wall (~30 s local, ~52 s estimated on the server, inside
  the 60 s budget; v1's ~36 s local ran ~62 s server-side and was killed).
  The top-50 bar was 800.383 on 28 Nov 07:40 WITA and the rank-1.000 line
  719.975 — v3 targets the top 1.000, not the (unreachable) top 50.
- Reference points: the kit's scale compressor scores 666,7 by construction;
  zlib level 9 on the same screened data scores 701,0; the house baseline
  (fixed Paeth, no form reduction) scores ~420 on this set.
- Wall time for the whole set of 8: ~30 s on this machine (limit 60 s).

## Run it

```sh
node main.ts            # reads /input/<id>/image.png, writes /output/<id>/image.png
```

Node 22, no dependencies, no network, no clock reads: the same input always
produces the same bytes.

## Licence

MIT — see [LICENSE](LICENSE).
