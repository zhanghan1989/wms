import importlib.util
from pathlib import Path
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("maintenance", Path(__file__).with_name("wms-binlog-maintenance.py"))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class BinlogBoundaryTests(unittest.TestCase):
    def test_retains_active_file_and_stops_at_first_ineligible_file(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            logs = [(f"binlog.{number:06d}", number) for number in range(1, 5)]
            cutoff = time.time() - 100
            for name, size in logs:
                (directory / name).write_bytes(b"x" * size)
                os.utime(directory / name, (cutoff - 10, cutoff - 10))
            self.assertEqual(maintenance.old_log_prefix(logs, directory, cutoff), logs[:-1])
            os.utime(directory / logs[1][0], (cutoff + 10, cutoff + 10))
            self.assertEqual(maintenance.old_log_prefix(logs, directory, cutoff), logs[:1])

    def test_does_not_purge_a_changed_or_mismatched_file(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "binlog.000001").write_bytes(b"longer than listed")
            cutoff = time.time()
            os.utime(directory / "binlog.000001", (cutoff - 10, cutoff - 10))
            self.assertEqual(maintenance.old_log_prefix([("binlog.000001", 1), ("binlog.000002", 2)], directory, cutoff), [])

    def test_rejects_non_binlog_names(self):
        with self.assertRaises(ValueError):
            maintenance.old_log_prefix([("../escape", 1), ("binlog.000002", 2)], Path("/tmp"), time.time())


if __name__ == "__main__":
    unittest.main()
