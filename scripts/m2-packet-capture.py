#!/usr/bin/env python3
"""Isolated CI-only packet capture for two reverse Agent TCP ports.

Uses Linux AF_PACKET without third-party tools. Runs with root privileges on
an ephemeral GitHub runner, not on user hosts. Writes a conventional Ethernet
PCAP and a machine-readable total; no packet payload is printed to CI logs.
"""
import json
import socket
import struct
import sys
import time

if __name__ != "__main__":
    raise SystemExit(2)

duration = float(sys.argv[1])
destination = sys.argv[2]
ports = {int(arg) for arg in sys.argv[3:]}
if not ports or any(p < 1 or p > 65535 for p in ports) or not 1 <= duration <= 20:
    raise SystemExit("invalid isolated capture parameters")

def has_agent_port(frame):
    if len(frame) < 14:
        return False
    kind = struct.unpack_from("!H", frame, 12)[0]
    if kind == 0x0800:
        if len(frame) < 34 or frame[23] != 6:
            return False
        size = (frame[14] & 15) * 4
        position = 14 + size
    elif kind == 0x86DD:
        if len(frame) < 54 or frame[20] != 6:
            return False
        position = 54
    else:
        return False
    if len(frame) < position + 4:
        return False
    src, dst = struct.unpack_from("!HH", frame, position)
    return src in ports or dst in ports

raw = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
raw.settimeout(0.3)
seen = 0
started = time.monotonic()
with open(destination, "wb") as file:
    # pcap linktype 1: Ethernet frames from AF_PACKET; caplen is bounded.
    file.write(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
    while time.monotonic() - started < duration:
        try:
            frame, _ = raw.recvfrom(65535)
        except socket.timeout:
            continue
        if not has_agent_port(frame):
            continue
        seen += 1
        timestamp = time.time()
        secs = int(timestamp)
        micros = int((timestamp - secs) * 1000000)
        file.write(struct.pack("<IIII", secs, micros, len(frame), len(frame)))
        file.write(frame)
raw.close()
print(json.dumps({"agent_tcp_packets": seen, "capture_seconds": duration, "ports": sorted(ports)}))
