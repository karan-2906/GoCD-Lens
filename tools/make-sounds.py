#!/usr/bin/env python3
"""Synthesise the notification chimes.

Shipping audio someone cannot inspect is a poor trade in an extension that asks
to be trusted, so the WAVs are generated here from a few lines of arithmetic
rather than downloaded. Re-run after changing them:

    python3 tools/make-sounds.py

They are deliberately short and quiet. A build notification that makes you jump
gets switched off within a day, which defeats the point of having it.
"""

import math
import struct
import wave
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "sounds"

RATE = 44_100
PEAK = 0.22  # a notification, not an alarm


def envelope(t, duration, attack, release):
    """Fade in and out so a note does not click at either end."""
    if t < attack:
        # Raised cosine rather than a straight ramp: no audible edge.
        return 0.5 - 0.5 * math.cos(math.pi * t / attack)
    if t > duration - release:
        x = (duration - t) / release
        return 0.5 - 0.5 * math.cos(math.pi * max(0.0, x))
    return 1.0


def tone(frequency, duration, *, at=0.0, harmonic=0.0, decay=0.0, attack=0.008, release=0.05):
    """One note.

    `harmonic` adds an octave above for body; too much of it and a low note
    turns to fuzz. `decay` makes the note die away rather than hold, which is
    what separates a chime from a beep.
    """
    return {
        "frequency": frequency,
        "duration": duration,
        "at": at,
        "harmonic": harmonic,
        "decay": decay,
        "attack": attack,
        "release": min(release, duration / 2),
    }


def render(notes):
    total = max(note["at"] + note["duration"] for note in notes)
    samples = [0.0] * int(total * RATE)

    for note in notes:
        offset = int(note["at"] * RATE)
        count = int(note["duration"] * RATE)
        for i in range(count):
            t = i / RATE
            phase = 2 * math.pi * note["frequency"] * t
            value = math.sin(phase) + note["harmonic"] * math.sin(2 * phase)
            value *= envelope(t, note["duration"], note["attack"], note["release"])
            if note["decay"]:
                value *= math.exp(-note["decay"] * t)
            index = offset + i
            if index < len(samples):
                samples[index] += value

    # Normalise so mixing notes never clips, then scale to the target peak.
    loudest = max((abs(s) for s in samples), default=1.0) or 1.0
    return [s / loudest * PEAK for s in samples]


def write_wav(path, samples):
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32_767)) for s in samples)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(frames)
    return len(frames) + 44


# A run starting is information, not news: one soft blip.
START = [tone(784.0, 0.10, harmonic=0.15, decay=4.0)]

# Rising major third, the universal "done, and fine".
SUCCESS = [
    tone(659.3, 0.10, harmonic=0.18, decay=5.0),
    tone(987.8, 0.20, harmonic=0.18, decay=4.0, at=0.085),
]

# Two short mid beeps, the way a device tells you no. Flat and unmistakable
# without being shrill, and it does not muddy on laptop speakers.
FAILURE = [
    tone(466.2, 0.08, harmonic=0.05, decay=6.0),
    tone(466.2, 0.16, harmonic=0.05, decay=5.0, at=0.13),
]


def main():
    OUT.mkdir(exist_ok=True)
    for name, notes in (("start", START), ("success", SUCCESS), ("failure", FAILURE)):
        size = write_wav(OUT / f"{name}.wav", render(notes))
        print(f"sounds/{name}.wav  {size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
