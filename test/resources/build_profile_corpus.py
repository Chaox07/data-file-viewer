"""Profiling corpus for test/resources/profile.test.ts and formatEquivalence.test.ts.

Run: conda run -n myproject python test/resources/build_profile_corpus.py
Writes to test/stress/_work/profile/ (gitignored). Deterministic: fixed seed,
fixed dates, so equivalence snapshots taken on two runs compare exactly.
Written by pandas/pyarrow/openpyxl on purpose -- a corpus written by the
reader's own library proves less (see test/stress/generators/_write.ts).
"""
import sqlite3
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc

OUT = Path(__file__).resolve().parents[1] / "stress" / "_work" / "profile"
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(20260924)
N = 200_000

frame = pd.DataFrame({
    "id": np.arange(N, dtype=np.int64),
    "region": rng.choice(["north", "south", "east", "west"], N),
    "amount": np.round(rng.normal(1000, 250, N), 4),
    "count": rng.integers(0, 10_000, N),
    "day": pd.date_range("1990-01-01", periods=N, freq="h").strftime("%Y-%m-%d"),
    "label": [f"item-{i % 997}" for i in range(N)],
})
# A numeric column holding Excel-style error markers: exercises interpretTextColumns.
marked = np.round(rng.normal(5, 1, N), 3).astype(str).astype(object)
marked[::5000] = "#N/A"
frame["marked"] = marked

frame.to_csv(OUT / "wide.csv", index=False)
frame.to_parquet(OUT / "wide.parquet", index=False)
table = pa.Table.from_pandas(frame, preserve_index=False)
with ipc.new_stream(str(OUT / "wide.arrows"), table.schema) as writer:
    writer.write_table(table, max_chunksize=65_536)
feather.write_feather(table, str(OUT / "wide.feather"), compression="uncompressed")  # compressed Feather is refused by design
frame.drop(columns=["marked"]).assign(day=lambda f: pd.to_datetime(f["day"])).to_stata(OUT / "wide.dta", write_index=False, version=118)

sq = OUT / "many.sqlite"
sq.unlink(missing_ok=True)
con = sqlite3.connect(sq)
for t in range(200):
    con.execute(f"create table t{t:03d} (id integer, name text, v real)")
    con.executemany(f"insert into t{t:03d} values (?,?,?)", [(i, f"n{i}", i * 0.5) for i in range(50)])
# One large table with undeclared column types (the slow retyping path).
con.execute("create table big (a, b, c)")
con.executemany("insert into big values (?,?,?)", ((i, f"text{i % 1000}", i * 1.25) for i in range(N)))
con.commit()
con.close()

import duckdb  # noqa: E402  (only needed for the .duckdb fixture)
db = OUT / "wide.duckdb"
db.unlink(missing_ok=True)
with duckdb.connect(str(db)) as d:
    d.execute("create table wide as select * from read_parquet(?)", [str(OUT / "wide.parquet")])

# Workbook heavy in shared strings: 40,000 rows x 6 columns, three tables on one sheet.
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Data"
ws.append(["Workbook notes"])
ws.append([])
ws.append(["id", "name", "city", "score", "date", "code"])
cities = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya"]
for i in range(40_000):
    ws.append([i, f"name {i % 3000}", cities[i % 5], round(i * 0.37 % 100, 2), f"2001-{(i % 12) + 1:02d}-15", f"C{i % 50:03d}"])
ws.append([])
ws.append(["key", "value"])
for i in range(20):
    ws.append([f"k{i}", i])
side = wb.create_sheet("Side")
side.append(["a", "b"])
for i in range(500):
    side.append([i, f"s{i}"])
wb.save(OUT / "strings.xlsx")

for p in sorted(OUT.iterdir()):
    print(f"{p.name:24s} {p.stat().st_size:>12,d}")
