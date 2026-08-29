"""
Fetch real elevation data for the Bailadila range and bake it into the repo.

    python -m scripts.fetch_dem

Source: AWS Open Data "Terrain Tiles" (terrarium encoding), a public, key-free
mosaic built from SRTM, ASTER and national datasets. Roughly 30 m native
resolution, which is the right order for a mine-scale twin — bench faces are
10-15 m lifts and haul roads 20-25 m wide.

Run this ONCE. It writes data/dem/bailadila.bin (Int16 metres) and a JSON
sidecar; after that the project is fully offline, which matters because the
mine network is air-gapped and the demo hall wifi cannot be trusted.

Swapping in NMDC's own survey later means replacing these two files. Nothing
else in the codebase knows where the elevations came from.
"""

from __future__ import annotations

import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "dem"

# Bailadila Deposit 14 / 11C, Kirandul complex, Dantewada, Chhattisgarh.
# The range runs roughly NNW-SSE; this box takes the deposit and the valley
# floor where the crusher and railhead sit.
NORTH, SOUTH = 18.735, 18.585
WEST, EAST = 81.155, 81.320

ZOOM = 13                     # ~19 m/px at this latitude
GRID = 480                    # output raster is GRID x GRID
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def deg2tile(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n
    return x, y


def tile2deg(x: float, y: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lon


def fetch_tile(z: int, x: int, y: int) -> np.ndarray:
    url = TILE_URL.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "fogtwin/1.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    cache = OUT_DIR / "tiles" / f"{z}_{x}_{y}.png"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(raw)
    img = np.asarray(Image.open(cache).convert("RGB")).astype(np.float64)
    # terrarium: height = (R * 256 + G + B / 256) - 32768
    return img[:, :, 0] * 256 + img[:, :, 1] + img[:, :, 2] / 256 - 32768


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    x0f, y0f = deg2tile(NORTH, WEST, ZOOM)
    x1f, y1f = deg2tile(SOUTH, EAST, ZOOM)
    tx0, tx1 = int(math.floor(x0f)), int(math.floor(x1f))
    ty0, ty1 = int(math.floor(y0f)), int(math.floor(y1f))

    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"fetching {cols}x{rows} tiles at zoom {ZOOM} "
          f"({NORTH}N {WEST}E to {SOUTH}N {EAST}E)")

    mosaic = np.zeros((rows * 256, cols * 256), dtype=np.float64)
    for j, ty in enumerate(range(ty0, ty1 + 1)):
        for i, tx in enumerate(range(tx0, tx1 + 1)):
            sys.stdout.write(f"\r  tile {tx},{ty} ... ")
            sys.stdout.flush()
            mosaic[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = fetch_tile(ZOOM, tx, ty)
    print("\r  all tiles fetched      ")

    # crop the mosaic to the requested box, in tile-pixel space
    px0 = (x0f - tx0) * 256
    px1 = (x1f - tx0) * 256
    py0 = (y0f - ty0) * 256
    py1 = (y1f - ty0) * 256

    # resample to a GRID x GRID raster, north-up, row 0 = NORTH
    ys = np.linspace(py0, py1 - 1, GRID)
    xs = np.linspace(px0, px1 - 1, GRID)
    yi = np.clip(ys.astype(int), 0, mosaic.shape[0] - 1)
    xi = np.clip(xs.astype(int), 0, mosaic.shape[1] - 1)
    grid = mosaic[np.ix_(yi, xi)]

    # a little smoothing: 30 m source data is stair-stepped at mine scale
    k = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float64) / 16.0
    pad = np.pad(grid, 1, mode="edge")
    smooth = sum(k[a, b] * pad[a:a + GRID, b:b + GRID]
                 for a in range(3) for b in range(3))

    out = np.round(smooth).astype(np.int16)
    (OUT_DIR / "bailadila.bin").write_bytes(out.tobytes(order="C"))

    # metres per raster cell, for the ENU frame
    mid_lat = (NORTH + SOUTH) / 2
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(mid_lat))
    span_x = (EAST - WEST) * m_per_deg_lon
    span_y = (NORTH - SOUTH) * m_per_deg_lat

    meta = {
        "name": "Bailadila range — Deposit 14 / 11C, Kirandul",
        "source": "AWS Open Data Terrain Tiles (terrarium), SRTM/ASTER derived",
        "licence": "public domain / CC0 source data",
        "zoom": ZOOM,
        "width": GRID, "height": GRID,
        "north": NORTH, "south": SOUTH, "west": WEST, "east": EAST,
        "span_x_m": round(span_x, 1), "span_y_m": round(span_y, 1),
        "cell_x_m": round(span_x / GRID, 2), "cell_y_m": round(span_y / GRID, 2),
        "min_m": int(out.min()), "max_m": int(out.max()),
        "dtype": "int16", "order": "row-major, row 0 = north edge",
    }
    (OUT_DIR / "bailadila.json").write_text(json.dumps(meta, indent=2))

    print(f"\nwrote data/dem/bailadila.bin  {out.nbytes / 1024:.0f} KB")
    print(f"      {GRID}x{GRID} cells, {meta['cell_x_m']} x {meta['cell_y_m']} m each")
    print(f"      elevation {meta['min_m']} to {meta['max_m']} m")
    print(f"      site span {span_x / 1000:.1f} x {span_y / 1000:.1f} km")


if __name__ == "__main__":
    main()
