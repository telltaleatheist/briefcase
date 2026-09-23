"""YTSeg sample -> JSON for snap-smoke.ts (Node has no parquet reader without a new dependency).

Reproduces ContentStudio's bench.py sample(n) exactly: the same filter (60-320 sentences, >= 3
chapter starts after the first two sentences) and pandas' sample(n, random_state=7), so the
videos are the ones the 0.72 / 0.23 figures were measured on. Needs pandas + pyarrow:

    python3 -m venv /tmp/ytseg && /tmp/ytseg/bin/pip install pandas pyarrow
    /tmp/ytseg/bin/python backend/src/scorer/live/ytseg-sample.py \
        --ref /Volumes/Callisto/Projects/Briefcase-worktrees/content-studio-chaptering-ref --n 24

Writes <ref>/bench-cache/ytseg-sample-<n>.json: [{id, cat, sents, labels}], in sample order.
labels[i] = 1 where a chapter starts at sentence i (bench.py: target_binary_wt[2:]).
"""
import argparse, json, os

import pandas as pd

SEED = 7


def sample(parquet, n):
    df = pd.read_parquet(parquet)
    df["n"] = df["text_wt"].apply(len)
    df["k"] = df["target_binary_wt"].apply(lambda s: s[2:].count("1"))
    pool = df[(df.n >= 60) & (df.n <= 320) & (df.k >= 3)]
    rows = pool.sample(n=n, random_state=SEED)
    return [{"id": r["video_id"], "cat": r["speaker_category"], "sents": [str(s) for s in r["text_wt"]],
             "labels": [int(c) for c in r["target_binary_wt"][2:]]} for _, r in rows.iterrows()]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="content-studio-chaptering-ref directory")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--out", help="output path (default <ref>/bench-cache/ytseg-sample-<n>.json)")
    a = ap.parse_args()
    vids = sample(os.path.join(a.ref, "ytseg/text/test-00000-of-00001.parquet"), a.n)
    out = a.out or os.path.join(a.ref, "bench-cache", f"ytseg-sample-{a.n}.json")
    json.dump(vids, open(out, "w"))
    print(f"wrote {len(vids)} videos to {out}")
