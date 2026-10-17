"""What a file is when it is not text: read_file names a picture or a binary file instead of decoding its bytes.

Decoded as UTF-8, a PNG came back to a worker as pages of replacement characters that rode every later turn and that it
then guessed from. A worker has no picture input, so the plain answer is what the file is: its type, its width and height
when the header holds them at a fixed place (a JPEG's takes one walk over its segment lengths), its size on disk, and
where to send it to have it looked at. No dependency: every field read here is a few header bytes.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import BinaryIO

HEAD_BYTES = 8192  # every verdict is read from the file's first 8 KB, as git's own binary check reads them
# Above this share of the head's bytes not decoding as UTF-8 it is not text. Random bytes come out near 45%; Latin-1
# prose with accents, a few percent.
UNDECODABLE_SHARE = 0.3

# By the bytes first: a renamed file is still what its bytes say. TIFF and ICO get no width and height here.
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"GIF87a", "GIF"),
    (b"GIF89a", "GIF"),
    (b"II*\x00", "TIFF"),
    (b"MM\x00*", "TIFF"),
    (b"\x00\x00\x01\x00", "ICO"),
)
# A BMP's "BM" alone would claim a text file that starts with it; its DIB header size (always holding NUL bytes) settles it.
_BMP_HEADERS = {12, 40, 52, 56, 64, 108, 124}
# By the name only when the bytes are already not text and no signature matched (a truncated or odd variant).
_BY_EXT = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF", ".webp": "WebP", ".bmp": "BMP",
           ".tif": "TIFF", ".tiff": "TIFF", ".ico": "ICO"}
_SENDABLE = {"PNG", "JPEG", "GIF", "WebP"}  # what hswarm_ask's images take (agent.image_part)
# A UTF-16/32 file (Windows PowerShell 5.1's `>` writes UTF-16) has a NUL in every ASCII char: it keeps today's read.
_WIDE_BOMS = (b"\xff\xfe", b"\xfe\xff", b"\x00\x00\xfe\xff")


def _magic(head: bytes) -> str | None:
    for signature, kind in _MAGIC:
        if head.startswith(signature):
            return kind
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WebP"
    if head[:2] == b"BM" and len(head) >= 26 and int.from_bytes(head[14:18], "little") in _BMP_HEADERS:
        return "BMP"
    return None


def _binary(head: bytes) -> str | None:
    """Why `head` is not text: "nul" (a NUL byte), "undecodable" (mostly not UTF-8), or None when it reads as text."""
    if head.startswith(_WIDE_BOMS):
        return None
    if b"\x00" in head:
        return "nul"
    dropped = len(head) - len(head.decode("utf-8", "ignore").encode("utf-8"))  # the bytes that are not UTF-8
    return "undecodable" if dropped > len(head) * UNDECODABLE_SHARE else None


def reads_as_text(path: Path) -> bool:
    """Whether read_file shows `path` as text; grep's rg-less walk skips the rest, as rg skips binary files."""
    with path.open("rb") as f:
        head = f.read(HEAD_BYTES)
    return _magic(head) is None and _binary(head) is None


def _dims(kind: str, head: bytes) -> tuple[int, int] | None:
    """Width and height from a PNG, GIF, BMP or WebP head's fixed header fields; None when they are not there."""
    if kind == "PNG" and len(head) >= 24 and head[12:16] == b"IHDR":
        return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
    if kind == "GIF" and len(head) >= 10:
        return int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little")
    if kind == "BMP":
        if int.from_bytes(head[14:18], "little") == 12:  # the old OS/2 header: 16-bit sides
            return int.from_bytes(head[18:20], "little"), int.from_bytes(head[20:22], "little")
        # A negative height is a bitmap stored top-down.
        return abs(int.from_bytes(head[18:22], "little", signed=True)), abs(int.from_bytes(head[22:26], "little", signed=True))
    if kind == "WebP":
        chunk = head[12:16]
        if chunk == b"VP8 " and len(head) >= 30 and head[23:26] == b"\x9d\x01\x2a":  # lossy: 14-bit sides after the start code
            return int.from_bytes(head[26:28], "little") & 0x3FFF, int.from_bytes(head[28:30], "little") & 0x3FFF
        if chunk == b"VP8L" and len(head) >= 25 and head[20] == 0x2F:  # lossless: two 14-bit (side - 1) fields packed
            bits = int.from_bytes(head[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8X" and len(head) >= 30:  # extended: the canvas's 24-bit (side - 1) fields
            return int.from_bytes(head[24:27], "little") + 1, int.from_bytes(head[27:30], "little") + 1
    return None


def _jpeg_dims(f: BinaryIO) -> tuple[int, int] | None:
    """Width and height from a JPEG's first start-of-frame segment, skipping segments by their lengths (an EXIF block
    can put it 64 KB in); None when the file ends, or its scan starts, before one."""
    f.seek(2)
    for _ in range(1000):  # a real JPEG has a few dozen segments before its frame
        if f.read(1) != b"\xff":
            return None
        marker = f.read(1)
        while marker == b"\xff":  # fill bytes before a marker
            marker = f.read(1)
        if not marker or marker[0] in (0xD9, 0xDA):
            return None
        if marker[0] == 0x01 or 0xD0 <= marker[0] <= 0xD7:
            continue  # a marker with no segment after it
        size = f.read(2)
        if len(size) < 2 or int.from_bytes(size, "big") < 2:
            return None
        if 0xC0 <= marker[0] <= 0xCF and marker[0] not in (0xC4, 0xC8, 0xCC):  # SOF0-15; C4, C8, CC are not frames
            frame = f.read(5)  # precision, height, width
            return (int.from_bytes(frame[3:5], "big"), int.from_bytes(frame[1:3], "big")) if len(frame) == 5 else None
        f.seek(int.from_bytes(size, "big") - 2, os.SEEK_CUR)
    return None


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} bytes"
    return f"{n / 1024:.1f} KB" if n < 1024 * 1024 else f"{n / (1024 * 1024):.1f} MB"


def describe(path: Path, shown: str) -> str | None:
    """read_file's whole answer for a picture or another binary file, named `shown`; None when `path` reads as text."""
    with path.open("rb") as f:
        head = f.read(HEAD_BYTES)
        signed = _magic(head)
        why = None if signed else _binary(head)
        if signed is None and why is None:
            return None
        kind = signed or _BY_EXT.get(path.suffix.lower())
        size = _size(os.fstat(f.fileno()).st_size)
        if kind is None:
            return f"{shown} is a binary file ({size}), {'not text' if why == 'nul' else 'not UTF-8 text'}; read_file shows text only."
        # Header fields only where the signature said where they are: a binary merely named .gif has none.
        dims = None if signed is None else _jpeg_dims(f) if kind == "JPEG" else _dims(kind, head)
    pixels = f", {dims[0]} x {dims[1]} pixels" if dims and min(dims) > 0 else ""
    send = "the file" if kind in _SENDABLE else "it as a PNG, JPEG, WebP or GIF (convert it first)"
    return (f"{shown} is a picture: {kind}{pixels}, {size}. read_file shows text only, so the picture's contents are not "
            f"visible here. If what it shows matters, say so: the caller can send {send} to hswarm_ask in `images`, "
            "which routes to a model that can see.")
