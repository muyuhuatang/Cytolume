"""Build and verify every layout from a fresh checkout: python -m spine.export.build_all."""

from importlib import import_module

from .paths import LAYOUTS


def main() -> int:
    stages = ["build_meta"]
    stages += [f"build_layout_{layout}" for layout in LAYOUTS]
    stages += [f"tile_{layout}" for layout in LAYOUTS]
    stages += ["build_manifest"]
    for stage in stages:
        print(f"\n--- {stage} ---", flush=True)
        import_module(f".{stage}", package=__package__).main()

    from .verify_spine import main as verify

    return verify()


if __name__ == "__main__":
    raise SystemExit(main())
