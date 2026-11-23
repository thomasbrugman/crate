"""Measure a music pulse with ffmpeg/numpy and write a frame-accurate cut grid."""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np

from common import SHOTS, beat_cuts


def analyze(music, seconds=45):
    rate, hop, size = 22050, 220, 1024
    audio = np.frombuffer(subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(music), '-t', str(seconds),
        '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-']), dtype='<f4')
    if len(audio) < rate * 8:
        raise ValueError('At least eight seconds of music are required')
    frames = np.lib.stride_tricks.sliding_window_view(audio, size)[::hop]
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(size), axis=1))
    flux = np.maximum(np.diff(np.log1p(spectrum * 10), axis=0), 0).sum(axis=1)
    flux = np.convolve(flux, [.2, .6, .2], mode='same')
    scale = np.percentile(flux, 95)
    if scale <= 0:
        raise ValueError('No measurable onsets')
    flux /= scale
    times = (np.arange(len(flux)) * hop + size / 2 + hop) / rate
    candidates = []
    for bpm in np.arange(75, 161, .05):
        period = 60 / bpm
        for phase in np.arange(0, period, .005):
            beats = np.arange(phase, min(40, times[-1]), period)
            candidates.append((float(np.interp(beats, times, flux).mean()), float(bpm), float(phase)))
    score, bpm, phase = max(candidates)
    return round(bpm, 2), phase, score, times, flux


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('music', type=Path)
    parser.add_argument('work_dir', type=Path)
    parser.add_argument('--start-beat', type=int, default=3)
    parser.add_argument('--cut-beats', default='0,6,14,22,30,38,44,50')
    args = parser.parse_args()
    bpm, phase, score, times, flux = analyze(args.music)
    cuts = [int(value) for value in args.cut_beats.split(',')]
    shots = beat_cuts(SHOTS, bpm, cuts)
    music_start = phase + args.start_beat * 60 / bpm
    evidence = []
    for beat in cuts:
        expected = music_start + beat * 60 / bpm
        indices = np.flatnonzero(abs(times - expected) < .055)
        if not len(indices):
            raise ValueError('Cut outside analyzed music')
        peak = indices[np.argmax(flux[indices])]
        evidence.append(dict(beat=beat, music_time=round(expected, 6),
                             cut_frame=round(beat * 60 / bpm * 60),
                             onset_time=round(float(times[peak]), 6),
                             onset_strength=round(float(flux[peak]), 4)))
    grid = dict(bpm=bpm, phase=phase, score=score, music_start=music_start,
                fps=60, cuts=evidence, shots=shots)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    (args.work_dir/'beat_grid.json').write_text(json.dumps(grid, indent=2))
    (args.work_dir/'shots.json').write_text(json.dumps(shots, indent=2))
    print(f'BPM {bpm} MUSIC_START {music_start:.6f}')
    for row in evidence:
        print('BEAT', row['beat'], 'MUSIC', row['music_time'], 'FRAME', row['cut_frame'],
              'ONSET', row['onset_time'], 'STRENGTH', row['onset_strength'])


if __name__ == '__main__':
    main()
