"""
The score for LockFi's product ad, synthesized so the film needs no licence.

    python3 scripts/build-lockfi-ad-audio.py out.wav 50

Cue times come from the film: a soft impact on the logo, a pad under the
opening lines, a pulse under the product scenes, risers into each scene
change, and an impact on the end card. AD_PULSE ("on,off"), AD_RISERS and
AD_BOOMS set them; the defaults are scripts/build-lockfi-ad.mjs's. A placeholder
worth replacing with a licensed track for paid distribution.
"""
import os
import sys
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

OUT = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0


def cues(name, default):
    """Cue times in seconds, from the environment, so each film sets its own."""
    raw = os.environ.get(name)
    return [float(x) for x in raw.split(',')] if raw else default


# Defaults are the product ad's (scripts/build-lockfi-ad.mjs).
PULSE_ON, PULSE_OFF = cues('AD_PULSE', [7.8, 44.4])
RISERS = cues('AD_RISERS', [7.8, 21.6, 33.7, 39.8])
BOOMS = cues('AD_BOOMS', [0.3, 44.45])
SR = 48000
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)

BPM = 96
BEAT = 60 / BPM
BAR = BEAT * 4


def lp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'low', fs=SR, output='sos'), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'high', fs=SR, output='sos'), x)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def saw(freq, length, detune=0.0):
    tt = np.arange(length) / SR
    out = np.zeros(length)
    for h in range(1, 9):  # band-limited: eight harmonics
        out += np.sin(2 * np.pi * freq * (1 + detune) * h * tt + rng.uniform(0, 6.28)) / h
    return out


# ── Pad: Am9 · Fmaj7 · Cadd9 · G6, two bars each ────────────────────────────
CHORDS = [
    [45, 57, 60, 64, 67, 71],  # A  : A2 A3 C4 E4 G4 B4
    [41, 53, 57, 60, 64, 69],  # F  : F2 F3 A3 C4 E4 A4
    [48, 55, 60, 62, 64, 67],  # C  : C3 G3 C4 D4 E4 G4
    [43, 55, 59, 62, 64, 67],  # G  : G2 G3 B3 D4 E4 G4
]
CH_LEN = BAR * 2
padL = np.zeros(N)
padR = np.zeros(N)
roots = np.zeros(N)
n_ch = int(np.ceil(DUR / CH_LEN)) + 1
for i in range(n_ch):
    start = i * CH_LEN
    s0 = int(start * SR)
    if s0 >= N:
        break
    length = min(int((CH_LEN + 1.6) * SR), N - s0)
    env_t = np.arange(length) / SR
    env = np.minimum(1, env_t / 1.1) * np.clip((CH_LEN + 1.6 - env_t) / 1.6, 0, 1)
    chord = CHORDS[i % 4]
    for j, note in enumerate(chord):
        f = midi(note)
        voice = saw(f, length, -0.0016) + saw(f, length, 0.0016)
        pan = 0.5 + 0.35 * np.sin(j * 1.7)
        amp = 0.22 if j == 0 else 0.13
        padL[s0:s0 + length] += voice * env * amp * (1 - pan)
        padR[s0:s0 + length] += voice * env * amp * pan
    roots[s0:min(N, s0 + int(CH_LEN * SR))] = midi(chord[0] - 12)

# The filter opens as the film builds: a dark and a bright pad, crossfaded.
bright = np.interp(t, [0, PULSE_ON, (PULSE_ON + PULSE_OFF) / 2, PULSE_OFF, DUR], [0.0, 0.25, 0.8, 1.0, 0.5])
padL = lp(padL, 750) * (1 - bright) + lp(padL, 2600) * bright
padR = lp(padR, 750) * (1 - bright) + lp(padR, 2600) * bright

# Reverb: a decaying noise tail.
ir_len = int(2.8 * SR)
ir_t = np.arange(ir_len) / SR
irL = rng.standard_normal(ir_len) * np.exp(-ir_t * 2.4)
irR = rng.standard_normal(ir_len) * np.exp(-ir_t * 2.4)
irL, irR = lp(irL, 5000) / 60, lp(irR, 5000) / 60
padL = padL * 0.7 + fftconvolve(padL, irL)[:N]
padR = padR * 0.7 + fftconvolve(padR, irR)[:N]

# ── Pulse: kick on the beat, bass pumped against it, hats on the off-beat ───
kick = np.zeros(N)
hats = np.zeros(N)
duck = np.ones(N)
k_len = int(0.45 * SR)
kt = np.arange(k_len) / SR
kick_one = np.sin(2 * np.pi * np.cumsum(48 + 70 * np.exp(-kt * 28)) / SR) * np.exp(-kt * 7.5)
kick_one += 0.25 * lp(rng.standard_normal(k_len) * np.exp(-kt * 120), 3000)
h_len = int(0.06 * SR)
hat_one = hp(rng.standard_normal(h_len), 7500) * np.exp(-np.arange(h_len) / SR * 70)
beat = PULSE_ON
while beat < PULSE_OFF:
    s0 = int(beat * SR)
    build = np.interp(beat, [PULSE_ON, PULSE_ON + 4.2, PULSE_OFF - 5.4, PULSE_OFF], [0.55, 1, 1, 0.8])
    kick[s0:s0 + k_len] += kick_one[: max(0, min(k_len, N - s0))] * build
    d0, d1 = s0, min(N, s0 + int(0.32 * SR))
    duck[d0:d1] = np.minimum(duck[d0:d1], 0.35 + 0.65 * np.linspace(0, 1, d1 - d0) ** 1.5)
    o0 = int((beat + BEAT / 2) * SR)
    if beat > PULSE_ON + 3.2 and o0 + h_len < N:
        hats[o0:o0 + h_len] += hat_one * 0.5 * build
    beat += BEAT

bass = np.sin(2 * np.pi * np.cumsum(roots) / SR) * 0.5
bass += 0.15 * np.sin(2 * 2 * np.pi * np.cumsum(roots) / SR)
bass *= np.interp(t, [0, PULSE_ON - 0.3, PULSE_ON, PULSE_OFF, PULSE_OFF + 0.8, DUR], [0, 0, 1, 1, 0.4, 0.2])
bass = lp(bass, 220) * duck

# ── Transitions: risers into each scene change, impacts on the two reveals ──
fx = np.zeros(N)
for cue in RISERS:
    a, b = int((cue - 1.4) * SR), int((cue + 0.25) * SR)
    seg = rng.standard_normal(b - a)
    rise = np.linspace(0, 1, b - a) ** 2.2
    rise[int(1.4 * SR):] = np.linspace(1, 0, b - a - int(1.4 * SR)) ** 2
    fx[a:b] += hp(lp(seg, 5500), 600) * rise * 0.22
for cue, size in zip(BOOMS, [0.8] + [1.0] * (len(BOOMS) - 1)):
    a = int(cue * SR)
    length = min(int(2.4 * SR), N - a)
    it = np.arange(length) / SR
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-it * 9)) / SR) * np.exp(-it * 2.2)
    boom += 0.4 * lp(rng.standard_normal(length), 900) * np.exp(-it * 5)
    fx[a:a + length] += boom * 0.9 * size

# ── Mix ─────────────────────────────────────────────────────────────────────
pad_level = np.interp(t, [0, 0.4, PULSE_ON, PULSE_OFF, DUR - 1.8, DUR], [0, 0.9, 0.75, 0.75, 0.9, 0])
padL *= pad_level * (0.55 + 0.45 * duck)
padR *= pad_level * (0.55 + 0.45 * duck)
mono = kick * 0.85 + bass + hats * 0.35 + fx
L = padL + mono
R = padR + mono
fade = np.interp(t, [0, 0.05, DUR - 1.5, DUR], [0, 1, 1, 0])
L, R = L * fade, R * fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.2) * 0.89, np.tanh(R / peak * 1.2) * 0.89

from scipy.io import wavfile  # noqa: E402

wavfile.write(OUT, SR, (np.stack([L, R], axis=1) * 32767).astype(np.int16))
print(f'  {OUT}  {DUR:.0f}s  peak -{20 * np.log10(1 / 0.89):.1f} dBFS before loudnorm')
