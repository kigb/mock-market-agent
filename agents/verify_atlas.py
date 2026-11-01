#!/usr/bin/env python3
"""Independently verify a finished round's Atlas randomness from its revealed secret.

    python verify_atlas.py arena-results.json

Checks SHA-256(secret) against atlas.commitment, regenerates the hidden center C and every
arrival from SHA-256(secret || seed || counter), and compares them with the revealed atlas.ticks.
Standard library only. The TypeScript engine (lib/arena/engine.ts, replayAtlas) is the reference;
this is a second implementation so the arena operator is not the only party who can replay a game.
"""
import hashlib
import json
import math
import struct
import sys

CENTER_RANGE_CENTS = (2000, 8000)
LIMIT_BAND_CENTS = 500
MEAN_INTERVAL_MS = 2000

def arrival_cap(duration_ms: int) -> int:
    """Three times the expected arrival count plus 50, matching the engine's schema-7 cap."""
    return math.ceil(duration_ms / MEAN_INTERVAL_MS) * 3 + 50

def js_round(x: float) -> int:
    """JavaScript Math.round: halves round toward +infinity, unlike Python's banker's rounding."""
    return math.floor(x + 0.5)

def uniform_stream(secret: bytes, seed: int):
    """Yield uniform [0,1) values: eight big-endian uint32 words per SHA-256(secret || seed || counter), each / 2^32."""
    counter = 0
    while True:
        digest = hashlib.sha256(secret + struct.pack('>II', seed, counter)).digest()
        counter += 1
        for i in range(8):
            yield struct.unpack('>I', digest[i*4:i*4+4])[0] / 4294967296

def replay(seed: int, secret_hex: str, started_at: int, ends_at: int):
    draw = uniform_stream(bytes.fromhex(secret_hex), seed).__next__
    low, high = CENTER_RANGE_CENTS
    center = low + math.floor(draw() * (high - low + 1))
    plan, t, cap = [], started_at, arrival_cap(ends_at - started_at)
    while len(plan) < cap:
        t += max(1, js_round(-math.log(1 - draw()) * MEAN_INTERVAL_MS))
        if t >= ends_at:
            break
        plan.append({'time': t, 'side': 'buy' if draw() < .5 else 'sell', 'quantity': 1 + math.floor(draw() * 5),
                     'limit': center + js_round((draw() * 2 - 1) * LIMIT_BAND_CENTS)})
    return center, plan

def verify(report: dict) -> bool:
    state = report.get('results', report)
    atlas = state['atlas']
    if state.get('status') != 'finished' or not atlas.get('secret'):
        print('The round is not finished or has no revealed secret (pre-schema-7 rounds cannot be replayed this way).')
        return False
    secret, commitment = atlas['secret'], atlas.get('commitment')
    digest = hashlib.sha256(bytes.fromhex(secret)).hexdigest()
    ok = True
    if digest != commitment:
        print(f'COMMITMENT MISMATCH: SHA-256(secret)={digest} but atlas.commitment={commitment}')
        ok = False
    else:
        print(f'Commitment OK: SHA-256(secret) = {commitment}')
    center, plan = replay(state['seed'], secret, state['startedAt'], state['endsAt'])
    if abs(center / 100 - atlas['center']) > 1e-9:
        print(f'CENTER MISMATCH: replayed {center/100:.2f}, revealed {atlas["center"]}')
        ok = False
    else:
        print(f'Center OK: C = {center/100:.2f}')
    ticks = atlas.get('ticks', [])
    revealed = [(t['time'], t['side'], t.get('requestedQuantity'), t.get('limitPrice')) for t in ticks]
    expected = [(p['time'], p['side'], p['quantity'], p['limit'] / 100) for p in plan]
    if len(revealed) != len(expected):
        print(f'ARRIVAL COUNT MISMATCH: revealed {len(revealed)}, replayed {len(expected)}')
        ok = False
    for i, (r, e) in enumerate(zip(revealed, expected)):
        if r[0] != e[0] or r[1] != e[1] or r[2] != e[2] or abs((r[3] or 0) - e[3]) > 1e-9:
            print(f'ARRIVAL {i} MISMATCH: revealed {r}, replayed {e}')
            ok = False
            break
    if ok:
        print(f'Plan OK: {len(expected)} arrivals match the revealed ticks. The round was not altered after creation.')
    decisions = report.get('decisions') or []
    if decisions:
        by_agent: dict = {}
        for d in decisions:
            if d.get('stalenessMs') is not None:
                by_agent.setdefault(d.get('agentId'), []).append(d['stalenessMs'])
        names = {a['id']: a['name'] for a in state.get('agents', [])}
        print('Observation staleness (execution − observation), ms:')
        for agent_id, values in by_agent.items():
            print(f'  {names.get(agent_id, agent_id):<24} n={len(values):<3} mean={sum(values)/len(values):8.1f} max={max(values):6}')
    return ok

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1]) as handle:
        sys.exit(0 if verify(json.load(handle)) else 1)
