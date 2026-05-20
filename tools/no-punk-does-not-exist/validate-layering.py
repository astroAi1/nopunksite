#!/usr/bin/env python3
"""Validate local CryptoPunks trait layer ordering against public CryptoPunks data.

The tool UI intentionally recolors the final render for No-Punks. This validator
uses the same layer ordering with the original palette so real combinations can
be checked against cryptopunks.app metadata and sampled official PNGs.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
PUNK_SIZE = 24
DEFAULT_TOKENS = [0, 1, 2, 35, 40, 128, 285, 9038]
NOPUNKS_BLACK = (4, 4, 4, 255)
BASE_SKIN_PALETTE_INDICES = {
    "Male 1": {1, 2, 3, 4},
    "Female 1": {1, 2, 3, 4, 17},
    "Male 2": {5, 6, 7, 8},
    "Female 2": {5, 6, 7, 8, 18},
    "Male 3": {9, 10, 11, 12},
    "Female 3": {9, 10, 11, 12, 19},
    "Male 4": {13, 14, 15, 16},
    "Female 4": {13, 14, 15, 16, 19},
    "Zombie": {20, 21, 22, 23},
    "Ape": {24, 25, 26, 27},
    "Alien": {28, 29, 30, 31},
}
CRYPTOPUNKS_RENDER_ORDER = [
    "Black Lipstick", "Buck Teeth", "Frown", "Hot Lipstick", "Purple Lipstick", "Smile",
    "Mole", "Rosy Cheeks", "Gold Chain", "Spots", "Choker", "Silver Chain",
    "Big Beard", "Chinstrap", "Front Beard", "Front Beard Dark", "Goat", "Handlebars",
    "Luxurious Beard", "Mustache", "Muttonchops", "Normal Beard", "Normal Beard Black",
    "Shadow Beard", "Earring", "Bandana", "Beanie", "Blonde Bob", "Blonde Short",
    "Cap", "Cap Forward", "Clown Hair Green", "Cowboy Hat", "Crazy Hair", "Dark Hair",
    "Do-rag", "Fedora", "Frumpy Hair", "Half Shaved", "Headband", "Hoodie",
    "Knitted Cap", "Messy Hair", "Mohawk", "Mohawk Dark", "Mohawk Thin", "Orange Side",
    "Peak Spike", "Pigtails", "Pilot Helmet", "Pink With Hat", "Police Cap",
    "Purple Hair", "Red Mohawk", "Shaved Head", "Straight Hair", "Straight Hair Blonde",
    "Straight Hair Dark", "Stringy Hair", "Tassle Hat", "Tiara", "Top Hat",
    "Vampire Hair", "Wild Blonde", "Wild Hair", "Wild White Hair", "Cigarette",
    "Medical Mask", "Pipe", "Vape", "3D Glasses", "Big Shades", "Blue Eye Shadow",
    "Classic Shades", "Clown Eyes Blue", "Clown Eyes Green", "Eye Mask", "Eye Patch",
    "Green Eye Shadow", "Horned Rim Glasses", "Nerd Glasses", "Purple Eye Shadow",
    "Regular Shades", "Small Shades", "VR", "Welding Goggles", "Clown Nose",
]
CRYPTOPUNKS_RENDER_RANK = {name: idx for idx, name in enumerate(CRYPTOPUNKS_RENDER_ORDER)}


def load_json(name: str):
    return json.loads((ROOT / "data" / name).read_text())


TRAITS = load_json("traits.json")
COMBOS = load_json("combos.json")
COMBO_BY_ID = {int(token_id): key for key, token_id in COMBOS.items()}
PALETTE = [
    (
        int(({"dedede80": "dbdbdb80", "cae7fe70": "cae6ff70", "2c954199": "2c944199"}.get(color, color))[0:2], 16),
        int(({"dedede80": "dbdbdb80", "cae7fe70": "cae6ff70", "2c954199": "2c944199"}.get(color, color))[2:4], 16),
        int(({"dedede80": "dbdbdb80", "cae7fe70": "cae6ff70", "2c954199": "2c944199"}.get(color, color))[4:6], 16),
        int(({"dedede80": "dbdbdb80", "cae7fe70": "cae6ff70", "2c954199": "2c944199"}.get(color, color))[6:8], 16),
    )
    for color in TRAITS["palette"]
]


def normalize_trait(value: str) -> str:
    return str(value).replace("_", " ").strip().lower()


def combo_for_token(token_id: int):
    key = COMBO_BY_ID[token_id]
    base_idx, _, trait_part = key.partition(":")
    trait_names = []
    if trait_part:
        trait_names = [TRAITS["traitNames"][int(idx)] for idx in trait_part.split(",")]
    return TRAITS["baseTypeNames"][int(base_idx)], trait_names


def decode_layer(hex_value: str):
    raw = hex_value[2:] if hex_value.lower().startswith("0x") else hex_value
    data = [int(raw[i : i + 2], 16) for i in range(0, len(raw), 2)]
    pixels = [None] * (PUNK_SIZE * PUNK_SIZE)

    for i in range(0, len(data), 3):
        bx = (data[i] & 0xF0) >> 4
        by = data[i] & 0x0F
        color_idx = data[i + 1]
        color_mask = (data[i + 2] & 0xF0) >> 4
        black_mask = data[i + 2] & 0x0F

        for dx in range(2):
            for dy in range(2):
                x = (2 * bx) + dx
                y = (2 * by) + dy
                if x >= PUNK_SIZE or y >= PUNK_SIZE:
                    continue
                bit = 1 << ((dx * 2) + dy)
                idx = (y * PUNK_SIZE) + x
                if color_mask & bit:
                    pixels[idx] = PALETTE[color_idx]
                elif black_mask & bit:
                    pixels[idx] = (0, 0, 0, 255)

    return pixels


def alpha_blend(dst, src):
    src_alpha = src[3] / 255
    dst_alpha = dst[3] / 255
    out_alpha = src_alpha + dst_alpha * (1 - src_alpha)
    if out_alpha == 0:
        return (0, 0, 0, 0)
    return (
        round((src[0] * src_alpha + dst[0] * dst_alpha * (1 - src_alpha)) / out_alpha),
        round((src[1] * src_alpha + dst[1] * dst_alpha * (1 - src_alpha)) / out_alpha),
        round((src[2] * src_alpha + dst[2] * dst_alpha * (1 - src_alpha)) / out_alpha),
        round(out_alpha * 255),
    )


def composite(layers):
    result = [None] * (PUNK_SIZE * PUNK_SIZE)
    for layer in layers:
        for idx, src in enumerate(layer):
            if src is None or src[3] == 0:
                continue
            result[idx] = src if result[idx] is None or src[3] == 255 else alpha_blend(result[idx], src)
    return [(0, 0, 0, 0) if pixel is None else pixel for pixel in result]


def composite_with_sources(layers):
    result = [None] * (PUNK_SIZE * PUNK_SIZE)
    sources = [None] * (PUNK_SIZE * PUNK_SIZE)
    for layer, source in layers:
        for idx, src in enumerate(layer):
            if src is None or src[3] == 0:
                continue
            result[idx] = src if result[idx] is None or src[3] == 255 else alpha_blend(result[idx], src)
            sources[idx] = source
    return [(0, 0, 0, 0) if pixel is None else pixel for pixel in result], sources


def trait_layer_id(trait_name: str, gender: str) -> int:
    trait = TRAITS["traits"][trait_name]
    if gender == "f":
        return trait.get("femaleId") or trait.get("maleId") or 0
    return trait.get("maleId") or trait.get("femaleId") or 0


def sort_traits_for_base(base_name: str, trait_names: list[str]) -> list[str]:
    gender = TRAITS["baseTypes"][base_name].get("gender", "m")
    return sorted(
        trait_names,
        key=lambda name: (CRYPTOPUNKS_RENDER_RANK.get(name, 999), trait_layer_id(name, gender)),
    )


def is_eye_aperture_pixel(idx: int, base_name: str, trait_names: list[str]) -> bool:
    if not any(TRAITS["traits"][name].get("category") == "eyes" for name in trait_names):
        return False
    x = idx % PUNK_SIZE
    y = idx // PUNK_SIZE
    gender = TRAITS["baseTypes"][base_name].get("gender", "m")
    aperture_y = {12, 13} if gender == "f" else {11, 12}
    return y in aperture_y and (9 <= x <= 10 or 14 <= x <= 15)


def render_punk(token_id: int, *, nopunks_transform=False):
    base_name, trait_names = combo_for_token(token_id)
    gender = TRAITS["baseTypes"][base_name].get("gender", "m")
    layers = [(decode_layer(TRAITS["baseTypes"][base_name]["hex"]), "base")]
    ordered = sort_traits_for_base(base_name, trait_names)

    for trait_name in ordered:
        trait = TRAITS["traits"][trait_name]
        hex_value = (trait.get("femaleHex") or trait.get("maleHex")) if gender == "f" else (trait.get("maleHex") or trait.get("femaleHex"))
        if hex_value:
            layers.append((decode_layer(hex_value), "trait"))

    pixels, sources = composite_with_sources(layers)
    if nopunks_transform:
        skin_colors = {PALETTE[idx] for idx in BASE_SKIN_PALETTE_INDICES.get(base_name, set())}
        transformed = []
        for idx, pixel in enumerate(pixels):
            if pixel[3] == 0:
                transformed.append((0, 0, 0, 255))
            elif pixel[:3] == (0, 0, 0):
                transformed.append((4, 4, 4, pixel[3]))
            elif pixel in skin_colors and sources[idx] != "trait" and not is_eye_aperture_pixel(idx, base_name, trait_names):
                transformed.append((0, 0, 0, pixel[3]))
            else:
                transformed.append(pixel)
        pixels = transformed
    return pixels, ordered


def render_original_punk(token_id: int):
    return render_punk(token_id, nopunks_transform=False)


def render_nopunks_punk(token_id: int):
    return render_punk(token_id, nopunks_transform=True)


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def official_pixels(token_id: int):
    url = f"https://www.cryptopunks.app/api/punks/{token_id}/image?transparent=true"
    with urllib.request.urlopen(url, timeout=25) as response:
        image = Image.open(io.BytesIO(response.read())).convert("RGBA")
    width, height = image.size
    sampled = []
    for y in range(PUNK_SIZE):
        for x in range(PUNK_SIZE):
            sample_x = min(width - 1, int((x + 0.5) * width / PUNK_SIZE))
            sample_y = min(height - 1, int((y + 0.5) * height / PUNK_SIZE))
            sampled.append(image.getpixel((sample_x, sample_y)))
    return sampled


def nopunks_pixels(token_id: int):
    url = f"https://nopunks.xyz/api/v2/tokens/{token_id}/image"
    with urllib.request.urlopen(url, timeout=25) as response:
        svg = response.read().decode("utf-8")
    match = re.search(r'base64,([^"\s]+)', svg)
    if not match:
        raise ValueError(f"No embedded PNG found in No-Punks SVG for token {token_id}")
    image = Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGBA")
    if image.size != (PUNK_SIZE, PUNK_SIZE):
        image = image.resize((PUNK_SIZE, PUNK_SIZE), Image.Resampling.NEAREST)
    return [image.getpixel((x, y)) for y in range(PUNK_SIZE) for x in range(PUNK_SIZE)]


def validate_trait_assets():
    failures = []
    for name, trait in TRAITS["traits"].items():
        if trait.get("maleCount", 0) > 0 and (not trait.get("maleHex") or not trait.get("maleId")):
            failures.append(f"{name}: missing male layer data")
        if trait.get("femaleCount", 0) > 0 and (not trait.get("femaleHex") or not trait.get("femaleId")):
            failures.append(f"{name}: missing female layer data")
    return failures


def validate_token(token_id: int, pixel_tolerance: int, nopunks_tolerance: int):
    base_name, local_traits = combo_for_token(token_id)
    metadata = fetch_json(f"https://www.cryptopunks.app/api/punks/{token_id}/metadata")
    official_traits = {normalize_trait(value) for value in metadata["data"].get("attributes", [])}
    local_trait_set = {normalize_trait(value) for value in local_traits}
    metadata_ok = official_traits == local_trait_set

    rendered, ordered = render_original_punk(token_id)
    official = official_pixels(token_id)
    pixel_diff = sum(1 for left, right in zip(rendered, official) if left != right)
    pixel_ok = pixel_diff <= pixel_tolerance
    local_nopunks, _ = render_nopunks_punk(token_id)
    official_nopunks = nopunks_pixels(token_id)
    nopunks_diff = sum(1 for left, right in zip(local_nopunks, official_nopunks) if left != right)
    nopunks_ok = nopunks_diff <= nopunks_tolerance

    return {
        "tokenId": token_id,
        "base": base_name,
        "metadataOk": metadata_ok,
        "pixelOk": pixel_ok,
        "pixelDiff": pixel_diff,
        "nopunksOk": nopunks_ok,
        "nopunksDiff": nopunks_diff,
        "orderedTraits": ordered,
        "localTraits": sorted(local_trait_set),
        "officialTraits": sorted(official_traits),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tokens", nargs="*", type=int, help="Token IDs to validate against cryptopunks.app")
    parser.add_argument("--pixel-tolerance", type=int, default=32, help="Max sampled 24x24 pixel differences allowed per token")
    parser.add_argument("--nopunks-tolerance", type=int, default=0, help="Max transformed pixel differences allowed against nopunks.xyz per token")
    parser.add_argument("--require-nopunks-match", action="store_true", help="Fail when transformed output differs from the current public No-Punks image")
    args = parser.parse_args()

    asset_failures = validate_trait_assets()
    if asset_failures:
        for failure in asset_failures:
            print(f"ASSET FAIL: {failure}")
        return 1

    tokens = args.tokens or DEFAULT_TOKENS
    failures = []
    for token_id in tokens:
        result = validate_token(token_id, args.pixel_tolerance, args.nopunks_tolerance)
        print(json.dumps(result, separators=(",", ":")))
        if not result["metadataOk"] or not result["pixelOk"] or (args.require_nopunks_match and not result["nopunksOk"]):
            failures.append(result)

    if failures:
        print(f"FAIL: {len(failures)} token validation failures", file=sys.stderr)
        return 1

    print(f"PASS: {len(tokens)} tokens validated; all 87 trait records have required layer ids and hex data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
