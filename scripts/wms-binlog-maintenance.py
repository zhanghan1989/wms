#!/usr/bin/env python3
"""Preview by default. Applying requires an explicit recovery/dependency review.

Uses MySQL PURGE only; never deletes MySQL files directly. Does not change the
row-image setting, stop containers, or create/upload a backup.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def run(args, source=None):
    result = subprocess.run(args, input=source, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Command failed; inspect the local Docker/MySQL logs before retrying")
    return result.stdout


def old_log_prefix(logs, data_dir, cutoff):
    """Only a contiguous closed-file prefix can be purged. Keep the active file."""
    candidates = []
    for name, size in logs[:-1]:
        if not re.fullmatch(r"binlog\.[0-9]+", name):
            raise ValueError("Unexpected binlog name")
        entry = (data_dir / name).stat()
        if entry.st_mtime >= cutoff or entry.st_size != size:
            break
        candidates.append((name, size))
    return candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="wms_db")
    parser.add_argument("--retain-days", type=int, default=7)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--verified-recovery-evidence", type=Path,
                        help="JSON: backup_location, restore_test_passed=true, verified_at_utc within 24h")
    parser.add_argument("--confirm-no-offline-consumers", action="store_true")
    parser.add_argument("--expected-purge-before", help="Exact boundary from the reviewed preview")
    parser.add_argument("--audit-dir", type=Path, default=Path("/var/lib/wms-storage-health/maintenance"))
    args = parser.parse_args()
    if not 7 <= args.retain_days <= 90:
        parser.error("Retention must be between 7 and 90 days")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        parser.error("Invalid container name")
    os.umask(0o077)
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now.timestamp() - args.retain_days * 86400

    def query(sql):
        return run(["docker", "exec", "-i", args.container, "sh", "-c",
                    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --raw --skip-column-names'], sql)

    mounts = json.loads(run(["docker", "inspect", "--format", "{{json .Mounts}}", args.container]))
    data_dirs = [Path(m["Source"]) for m in mounts if m["Destination"] == "/var/lib/mysql"]
    if len(data_dirs) != 1:
        raise RuntimeError("Cannot identify the persistent MySQL data directory")
    logs = [(parts[0], int(parts[1])) for line in query("SHOW BINARY LOGS;").splitlines()
            if len(parts := line.split("\t")) >= 2]
    if not logs:
        raise RuntimeError("No binary logs returned")
    candidates = old_log_prefix(logs, data_dirs[0], cutoff)
    boundary = logs[len(candidates)][0]
    if not re.fullmatch(r"binlog\.[0-9]+", boundary):
        raise RuntimeError("Unexpected purge boundary")
    active_consumers = int(query("SELECT COUNT(*) FROM information_schema.processlist WHERE COMMAND LIKE 'Binlog Dump%';").strip())
    replica_channels = int(query("SELECT COUNT(*) FROM performance_schema.replication_connection_configuration;").strip())
    settings = query("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('binlog_expire_logs_seconds','binlog_row_image');").strip()
    plan = {"sampled_at_utc": now.isoformat(), "retain_days": args.retain_days,
            "cutoff_utc": dt.datetime.fromtimestamp(cutoff, dt.timezone.utc).isoformat(),
            "purge_before": boundary, "candidate_files": [name for name, _ in candidates],
            "candidate_bytes": sum(size for _, size in candidates),
            "active_binlog_consumers": active_consumers, "replica_channels": replica_channels,
            "settings_before": settings, "mode": "apply" if args.apply else "preview"}
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if not args.apply:
        return
    if not args.confirm_no_offline_consumers or args.expected_purge_before != boundary:
        raise RuntimeError("Apply requires offline-consumer review and the exact preview boundary")
    if active_consumers or replica_channels:
        raise RuntimeError("Replication dependencies exist; use a replication-aware maintenance procedure")
    if not args.verified_recovery_evidence:
        raise RuntimeError("Apply requires a recent verified-recovery evidence file")
    evidence_bytes = args.verified_recovery_evidence.read_bytes()
    evidence = json.loads(evidence_bytes)
    verified = dt.datetime.fromisoformat(evidence["verified_at_utc"].replace("Z", "+00:00"))
    age = (now - verified).total_seconds()
    if evidence.get("restore_test_passed") is not True or not evidence.get("backup_location") or not 0 <= age <= 86400:
        raise RuntimeError("Recovery evidence must identify a backup and a successful restore test within 24h")
    args.audit_dir.mkdir(parents=True, exist_ok=True)
    record = args.audit_dir / (now.strftime("%Y%m%dT%H%M%SZ") + ".json")
    plan["recovery_evidence_sha256"] = hashlib.sha256(evidence_bytes).hexdigest()
    plan["status"] = "prepared"
    with record.open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, ensure_ascii=False, indent=2)
    # Boundaries remain file-based: a long quiet period must not delete the
    # current active log, even when its mtime predates the requested cutoff.
    query(f"PURGE BINARY LOGS TO '{boundary}';")
    query(f"SET PERSIST binlog_expire_logs_seconds = {args.retain_days * 86400};")
    remaining = query("SHOW BINARY LOGS;")
    plan["status"] = "complete"
    plan["remaining_log_count"] = len(remaining.splitlines())
    record.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Maintenance complete; audit record:", record)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print("Maintenance stopped:", error, file=sys.stderr)
        sys.exit(1)
