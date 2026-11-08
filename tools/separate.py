"""Split songs into vocals and music with Demucs, an open-source source-separation model (Meta AI, MIT licence).

The app's own "vocals only / music only" uses a quick trick (centre channel), which leaks. Demucs is a neural
network trained on thousands of songs with their separate tracks: it predicts, moment by moment, which part of the
sound belongs to the voice, the drums, the bass and the rest. It is far cleaner, but too heavy for a browser, so it
runs here on your computer and writes ordinary audio files that you then add to the app's Library.

    pip install demucs                       # once; downloads PyTorch too (about 2 GB)
    python tools/separate.py song1.mp3 song2.mp3            # -> separated/<song>/vocals.mp3 and no_vocals.mp3
    python tools/separate.py --four song.mp3                # vocals, drums, bass and other

A three-minute song takes one to five minutes on an ordinary laptop processor; a graphics card is much faster.
"""
import shutil, subprocess, sys
from pathlib import Path


def main(args):
    four = "--four" in args
    files = [a for a in args if a != "--four"]
    if not files:
        print(__doc__); return 1
    try:
        import demucs  # noqa: F401
    except ImportError:
        print("Demucs is not installed. Install it once with:\n    pip install demucs\nthen run this again."); return 1
    out = Path("separated")
    cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "--mp3", "-o", str(out)] + ([] if four else ["--two-stems", "vocals"]) + files
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)
    for f in files:                       # demucs writes separated/htdemucs/<name>/; move up one level for clarity
        src = out / "htdemucs" / Path(f).stem
        dst = out / Path(f).stem
        if src.exists():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.move(str(src), str(dst))
            print("stems:", ", ".join(sorted(p.name for p in dst.iterdir())), "in", dst)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
