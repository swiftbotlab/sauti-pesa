#!/usr/bin/env python3
"""Pick a fixed set of FLEURS Swahili (sw_ke) test clips and extract ONLY those from the audio archive.

    python3 -I scripts/fleurs_prepare.py TSV TARBALL OUTDIR [COUNT]

Called by scripts/eval_fleurs_asr.sh. The TSV and the archive are downloaded, UNTRUSTED data: the TSV is parsed
as plain tab-separated cells with strict per-field checks (bad rows are counted and skipped), and from the archive
only regular files named test/<digits>.wav that are in the selection are written, by basename, into OUTDIR/clips/
(no links, no directories, no paths from the archive, a size cap per file). Nothing in the data is executed.

Selection (deterministic, no randomness): group rows by utterance id, sort ids numerically, and for each id take the
first recording (by file name, numerically) that is within the app's 30 s audio limit; keep the first COUNT ids
(default 40). One recording per sentence, so no sentence is counted twice.
FLEURS ships 32-bit float WAV; the app accepts 16-bit PCM WAV (what its own recorder sends). Each clip is converted
with the same formula as the app's recorder (ui/app.js encodeWav: clamp to [-1, 1], negative x 32768, positive
x 32767, truncated): no resampling, gain, filtering or trimming. Writes OUTDIR/selected.json.
"""
import json
import os
import re
import struct
import sys
import tarfile
import unicodedata

SAMPLE_RATE = 16000          # FLEURS audio is 16 kHz
MAX_SECONDS = 30             # the app refuses longer audio (src/asr.js MAX_AUDIO_SECONDS)
MAX_TSV_BYTES = 2_000_000
MAX_WAV_BYTES = 5 * 1024 * 1024  # the app's MAX_AUDIO_BYTES
MAX_TEXT = 2000
CONTROL = re.compile('[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]')
ID_RE = re.compile(r'[0-9]{1,6}')
FILE_RE = re.compile(r'[0-9]{1,25}\.wav')
MEMBER_RE = re.compile(r'(?:\./)?test/([0-9]{1,25}\.wav)')


def text_cell(s):
    s = unicodedata.normalize('NFKC', s)
    s = CONTROL.sub(' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    if not s or len(s) > MAX_TEXT:
        raise ValueError('bad text cell')
    return s


def parse_tsv(path):
    if os.path.islink(path) or not os.path.isfile(path):
        raise SystemExit('TSV must be a regular file')
    if os.path.getsize(path) > MAX_TSV_BYTES:
        raise SystemExit('TSV too large')
    with open(path, 'rb') as f:
        raw = f.read(MAX_TSV_BYTES + 1).decode('utf-8')  # strict: a decoding error stops the run
    rows, bad = [], 0
    for line in raw.split('\n'):
        if not line.strip():
            continue
        c = line.rstrip('\r').split('\t')
        try:
            if len(c) != 7:
                raise ValueError('columns')
            uid, fname, raw_tr, tr, _chars, nsamp, gender = c
            if not ID_RE.fullmatch(uid) or not FILE_RE.fullmatch(fname) or not re.fullmatch(r'[0-9]{1,9}', nsamp):
                raise ValueError('field')
            if gender not in ('MALE', 'FEMALE', 'OTHER'):
                raise ValueError('gender')
            rows.append({'id': int(uid), 'file': fname, 'raw_transcription': text_cell(raw_tr),
                         'transcription': text_cell(tr), 'num_samples': int(nsamp), 'gender': gender})
        except ValueError:
            bad += 1
        if len(rows) > 5000:
            raise SystemExit('too many rows')
    return rows, bad


def select(rows, count):
    by_id = {}
    for r in rows:
        by_id.setdefault(r['id'], []).append(r)
    picked, skipped_long = [], 0
    for uid in sorted(by_id):
        ok = [r for r in sorted(by_id[uid], key=lambda r: int(r['file'][:-4]))
              if 0 < r['num_samples'] <= MAX_SECONDS * SAMPLE_RATE]
        if not ok:
            skipped_long += 1
            continue
        picked.append(ok[0])
        if len(picked) == count:
            break
    return picked, skipped_long, len(by_id)


def to_pcm16(data):
    """Parse a WAV held in memory and return (16-bit PCM mono WAV bytes, source format, clamped sample count)."""
    off, fmt, payload = 12, None, None
    while off + 8 <= len(data):
        cid, size = data[off:off + 4], struct.unpack_from('<I', data, off + 4)[0]
        body = data[off + 8:off + 8 + size]
        if cid == b'fmt ' and len(body) >= 16:
            fmt = struct.unpack_from('<HHIIHH', body, 0)
        elif cid == b'data':
            payload = body
            break
        off += 8 + size + (size & 1)
    if fmt is None or payload is None:
        raise ValueError('WAV without fmt/data chunk')
    tag, channels, rate, _br, _align, bits = fmt
    if channels != 1 or rate != SAMPLE_RATE:
        raise ValueError(f'expected mono {SAMPLE_RATE} Hz, got {channels} ch {rate} Hz')
    if tag == 1 and bits == 16:
        pcm, kind, clamped = payload[:len(payload) & ~1], 'pcm16', 0
    elif tag == 3 and bits == 32:
        out, clamped = bytearray(), 0
        for (x,) in struct.iter_unpack('<f', payload[:len(payload) & ~3]):
            if x != x:  # NaN
                x = 0.0
            c = max(-1.0, min(1.0, x))
            clamped += c != x
            out += struct.pack('<h', int(c * 32768) if c < 0 else int(c * 32767))
        pcm, kind = bytes(out), 'float32'
    else:
        raise ValueError(f'unsupported WAV format {tag}/{bits} bit')
    if len(pcm) / 2 > MAX_SECONDS * SAMPLE_RATE:
        raise ValueError('clip longer than 30 s')
    hdr = b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
    return hdr + b'data' + struct.pack('<I', len(pcm)) + pcm, kind, clamped


def extract(tar_path, wanted, outdir):
    if os.path.islink(tar_path) or not os.path.isfile(tar_path):
        raise SystemExit('archive must be a regular file')
    clips = os.path.join(outdir, 'clips')
    os.makedirs(clips, mode=0o700, exist_ok=True)
    if os.path.islink(clips) or os.path.realpath(clips) != os.path.abspath(clips):
        raise SystemExit('clips dir must not be a link')
    left = set(wanted)
    seen = 0
    info = {}
    with tarfile.open(tar_path, mode='r|gz') as tar:  # stream: one pass, members in archive order
        for m in tar:
            seen += 1
            if seen > 100_000:
                raise SystemExit('archive has too many members')
            mm = MEMBER_RE.fullmatch(m.name)
            if not mm or not m.isreg() or mm.group(1) not in left:
                continue
            if m.size <= 44 or m.size > MAX_WAV_BYTES:
                raise SystemExit(f'{mm.group(1)}: unexpected size {m.size}')
            src = tar.extractfile(m)
            data = src.read(MAX_WAV_BYTES + 1)
            if len(data) != m.size or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
                raise SystemExit(f'{mm.group(1)}: not a WAV file')
            try:
                wav, kind, clamped = to_pcm16(data)
            except (ValueError, struct.error) as e:
                raise SystemExit(f'{mm.group(1)}: {e}')
            dst = os.path.join(clips, mm.group(1))
            fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(wav)
            info[mm.group(1)] = {'source_format': kind, 'clamped_samples': clamped}
            left.discard(mm.group(1))
            if not left:
                break
    if left:
        raise SystemExit(f'{len(left)} selected clips not found in the archive')
    return info


def main():
    if len(sys.argv) not in (4, 5):
        raise SystemExit(__doc__)
    tsv, tar_path, outdir = sys.argv[1:4]
    count = int(sys.argv[4]) if len(sys.argv) == 5 else 40
    if not 1 <= count <= 400:
        raise SystemExit('COUNT must be 1-400')
    rows, bad = parse_tsv(tsv)
    picked, skipped_long, n_ids = select(rows, count)
    if len(picked) < count:
        raise SystemExit(f'only {len(picked)} clips could be selected')
    info = extract(tar_path, [r['file'] for r in picked], outdir)
    kinds = sorted({v['source_format'] for v in info.values()})
    out = {
        'rows': len(rows), 'bad_rows': bad, 'distinct_ids': n_ids,
        'ids_skipped_over_30s_before_count_reached': skipped_long,
        'rule': ('ids sorted numerically; per id the first recording (file name, numerically) within 30 s; '
                 f'first {count} ids'),
        'audio_conversion': {'source_formats': kinds, 'to': '16-bit PCM mono 16 kHz WAV',
                             'formula': 'ui/app.js encodeWav (clamp [-1,1]; x<0 -> x*32768, else x*32767; truncate)',
                             'clamped_samples_total': sum(v['clamped_samples'] for v in info.values())},
        'clips': picked,
    }
    tmp = os.path.join(outdir, 'selected.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(outdir, 'selected.json'))
    genders = {}
    for r in picked:
        genders[r['gender']] = genders.get(r['gender'], 0) + 1
    secs = sum(r['num_samples'] for r in picked) / SAMPLE_RATE
    print(json.dumps({'selected': len(picked), 'ids': [picked[0]['id'], picked[-1]['id']], 'genders': genders,
                      'audio_s': round(secs, 1), 'bad_rows': bad, 'skipped_over_30s': skipped_long}))


if __name__ == '__main__':
    main()
