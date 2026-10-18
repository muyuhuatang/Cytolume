"""Encode actual Chrome frames and reject blank anatomy panels before publishing."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageSequence


def anatomy_pixels(image, box):
    bounds = (round(box["x"]), round(box["y"]),
              round(box["x"] + box["width"]), round(box["y"] + box["height"]))
    region = image.crop(bounds).convert("RGB").resize((122, 150))
    pixels = region.tobytes()
    ink = []
    for index, (red, green, blue) in enumerate(zip(pixels[0::3], pixels[1::3], pixels[2::3])):
        if max(red, green, blue) - min(red, green, blue) > 25 and max(red, green, blue) > 60:
            ink.append(index // 122)
    span = max(ink) - min(ink) if ink else 0
    if len(ink) < 180 or span < 65:
        raise ValueError(f"Anatomy did not paint a body silhouette (colored pixels={len(ink)}, height={span}).")
    return len(ink)


def encode(capture_path, output_path, width=1120):
    capture = json.loads(Path(capture_path).read_text(encoding="utf-8"))
    paths = capture["files"]
    if len(paths) < 2:
        raise ValueError("An animated GIF needs multiple captured frames.")
    viewport = capture["viewport"]
    width = min(width, viewport["width"])
    height = round(viewport["height"] * width / viewport["width"])
    frame_ms = round(1000 / capture["fps"] / 10) * 10
    frames, palette, body_counts = [], None, []
    for path in paths:
        with Image.open(path) as source:
            source.load()
            if source.size != (viewport["width"], viewport["height"]):
                raise ValueError(f"Capture dimensions changed: {path}")
            image = source.convert("RGB")
        body_counts.append(anatomy_pixels(image, capture["bodyBox"]))
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        if palette is None:
            palette = image.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
        frames.append(image.quantize(palette=palette, dither=Image.Dither.NONE))

    frames[0].save(output_path, format="GIF", save_all=True, append_images=frames[1:],
                   loop=0, duration=frame_ms, disposal=1, optimize=False,
                   palette=palette.getpalette())
    with Image.open(output_path) as result:
        if result.format != "GIF" or result.n_frames < 2:
            raise ValueError("The output is not an animated GIF.")
        duration = sum(frame.info.get("duration", 0) for frame in ImageSequence.Iterator(result))
        if duration != frame_ms * len(paths):
            raise ValueError("GIF frame timing did not survive encoding.")
        frame_count = result.n_frames
    return {"frames": frame_count, "durationMs": duration, "width": width, "height": height,
            "bytes": Path(output_path).stat().st_size, "minimumAnatomyPixels": min(body_counts)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int, default=1120)
    arguments = parser.parse_args()
    print(json.dumps(encode(arguments.capture, arguments.output, arguments.width)))
