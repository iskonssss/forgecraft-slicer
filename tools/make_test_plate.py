"""
Writes test/test-plate.stl: a neutral stand-in for a student name plate.

  - backing plate   120 x 40 x 5 mm
  - 5 raised "letters" (bars) on top of it, 5 -> 6 mm   -> must be detected
  - keyring loop beside it, 0 -> 6 mm (same height)      -> must NOT be detected
  - back stand along the rear edge, 0 -> 15 mm           -> must NOT be detected

The automatic GitHub rebuild slices this on every printer to prove the
letter colouring still works.
"""
import math
import os
import struct

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "test-plate.stl")


def box(x0, y0, z0, x1, y1, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
         (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return [(v[a], v[b], v[c]) for a, b, c in f]


def ring(cx, cy, r_in, r_out, z0, z1, seg=48):
    tris = []
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        o0 = (cx + r_out * math.cos(a0), cy + r_out * math.sin(a0))
        o1 = (cx + r_out * math.cos(a1), cy + r_out * math.sin(a1))
        i0 = (cx + r_in * math.cos(a0), cy + r_in * math.sin(a0))
        i1 = (cx + r_in * math.cos(a1), cy + r_in * math.sin(a1))
        O0b, O1b, O0t, O1t = (*o0, z0), (*o1, z0), (*o0, z1), (*o1, z1)
        I0b, I1b, I0t, I1t = (*i0, z0), (*i1, z0), (*i0, z1), (*i1, z1)
        tris += [(O0t, O1t, I1t), (O0t, I1t, I0t)]          # top
        tris += [(O0b, I1b, O1b), (O0b, I0b, I1b)]          # bottom
        tris += [(O0b, O1b, O1t), (O0b, O1t, O0t)]          # outer wall
        tris += [(I0b, I1t, I1b), (I0b, I0t, I1t)]          # inner wall
    return tris


def write_stl(path, tris):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"Forgecraft test plate".ljust(80, b"\0"))
        fh.write(struct.pack("<I", len(tris)))
        for t in tris:
            fh.write(struct.pack("<3f", 0, 0, 0))
            for p in t:
                fh.write(struct.pack("<3f", *p))
            fh.write(b"\0\0")


if __name__ == "__main__":
    tris = box(0, 0, 0, 120, 40, 5)                       # backing
    for i in range(5):                                    # letters
        x = 12 + i * 21
        tris += box(x, 8, 5, x + 9, 32, 6)
    tris += ring(140, 20, 8, 12, 0, 6)                    # keyring loop
    tris += box(0, 40, 0, 120, 45, 15)                    # back stand
    write_stl(OUT, tris)
    print("wrote", OUT, len(tris), "triangles")
