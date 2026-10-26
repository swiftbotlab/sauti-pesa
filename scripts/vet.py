#!/usr/bin/env python3
"""Supply-chain check for npm packages BEFORE they are installed.

For every spec: `npm view` (maintainers, scripts, integrity, provenance), `npm pack` into an EMPTY directory,
sha512 of the tarball vs dist.integrity, then list lifecycle scripts, native prebuilds and a few risky
patterns (child_process, eval, process.env, hard-coded URLs) from the tarball WITHOUT running any of it.

  python3 -I scripts/vet.py @qvac/sdk@0.22.0 @tetherto/wdk@1.0.0-beta.22 ...
Writes vetting/<name>@<version>.json and prints a summary.
"""
import base64, hashlib, json, os, re, subprocess, sys, tarfile

PROD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(PROD, "vetting")
WORK = os.path.join(PROD, "tmp", "vet")
LIFECYCLE = ("preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare")
RISKY = {
    "child_process": re.compile(rb"child_process"),
    "eval": re.compile(rb"\beval\(|new Function\("),
    "process.env": re.compile(rb"process\.env\.[A-Z_]+"),
    "url": re.compile(rb"https?://[a-zA-Z0-9.\-]+"),
}


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed: {r.stderr[-400:]}")
    return r.stdout


def vet(spec):
    meta = json.loads(run(["npm", "view", spec, "--json"]))
    if isinstance(meta, list):
        meta = meta[-1]
    name, ver = meta["name"], meta["version"]
    safe = f"{name.replace('/', '__')}@{ver}"
    d = os.path.join(WORK, safe)
    os.makedirs(d, exist_ok=True)
    if os.listdir(d):
        raise SystemExit(f"{d} is not empty; remove it first")
    out = run(["npm", "pack", f"{name}@{ver}", "--ignore-scripts", "--pack-destination", d, "--json"], cwd=d)
    tgz = os.path.join(d, json.loads(out)[0]["filename"])
    raw = open(tgz, "rb").read()
    got = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    want = meta["dist"]["integrity"]
    files, scripts, prebuilds, hits = 0, {}, [], {k: set() for k in RISKY}
    big = []
    with tarfile.open(tgz, "r:gz") as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            files += 1
            p = m.name
            if "/prebuilds/" in p or p.endswith(".node") or p.endswith(".bare"):
                prebuilds.append(f"{p} ({m.size} B)")
            if m.size > 5_000_000:
                big.append(f"{p} ({m.size} B)")
            if p == "package/package.json":
                pj = json.loads(tf.extractfile(m).read())
                scripts = {k: v for k, v in (pj.get("scripts") or {}).items() if k in LIFECYCLE}
            if p.endswith((".js", ".mjs", ".cjs")) and m.size < 3_000_000:
                body = tf.extractfile(m).read()
                for k, rx in RISKY.items():
                    for hit in rx.findall(body)[:20]:
                        if k == "url" or k == "process.env":
                            hits[k].add(hit.decode("latin-1"))
                        else:
                            hits[k].add(p)
    rep = {
        "spec": f"{name}@{ver}",
        "maintainers": meta.get("maintainers"),
        "license": meta.get("license"),
        "repository": (meta.get("repository") or {}).get("url"),
        "published": (meta.get("time") or {}).get(ver),
        "integrity_registry": want,
        "integrity_tarball": got,
        "integrity_match": got == want,
        "provenance": bool((meta["dist"].get("attestations") or {}).get("provenance")),
        "lifecycle_scripts": scripts,
        "dependencies": meta.get("dependencies"),
        "file_count": files,
        "native_prebuilds": prebuilds[:60],
        "native_prebuild_count": len(prebuilds),
        "files_over_5MB": big,
        "child_process_in": sorted(hits["child_process"])[:40],
        "eval_in": sorted(hits["eval"])[:40],
        "env_vars_read": sorted(hits["process.env"])[:60],
        "hosts_in_code": sorted(hits["url"])[:80],
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{safe}.json"), "w") as f:
        json.dump(rep, f, indent=1)
    return rep


if __name__ == "__main__":
    for spec in sys.argv[1:]:
        r = vet(spec)
        print(f"{r['spec']}: integrity_match={r['integrity_match']} provenance={r['provenance']} "
              f"maint={[m.split(' ')[0] for m in r['maintainers'] or []]} scripts={r['lifecycle_scripts']} "
              f"files={r['file_count']} prebuilds={r['native_prebuild_count']} child_process={len(r['child_process_in'])} "
              f"eval={len(r['eval_in'])}")
