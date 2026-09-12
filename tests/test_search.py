"""Unit tests verifying mathematical accuracy, regression vectors, and digest consistency."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import search_core as core


class SearchCoreTests(unittest.TestCase):
    def test_canonical_contexts(self):
        self.assertEqual(len(core.CONTEXTS), 81)
        self.assertEqual(core.CONTEXTS[0]["id"], "c00")
        self.assertEqual(core.CONTEXTS[-1]["id"], "c80")

    def test_historical_positive_solutions(self):
        """Tests that the curve scanner correctly flags known historical solutions for k."""
        fixtures = [
            (39, [-159380, 134476, 117367]),
            (84, [41639611, -41531726, -8241191]),
            (30, [2220422932, -2218888517, -283059965]),
            (75, [-435203231, 435203083, 4381159]),
            (69, [-1213102, 261692, 1209029]),
        ]
        for k, xyz in fixtures:
            sorted_xyz = sorted(xyz, key=abs)
            z, x, y = sorted_xyz
            d = abs(x + y)
            r = z % d
            q = z // d
            hits = core.scan_curve(k, d, r, q, q)["hits"]
            self.assertEqual(len(hits), 1)
            self.assertEqual(sorted(map(int, hits[0]["xyz"])), sorted(xyz))
            self.assertTrue(core.verify_triple(hits[0]["xyz"], k))

    def test_triple_verifier(self):
        self.assertFalse(core.verify_triple(["1", "2", "3"], 114))
        self.assertFalse(core.verify_triple(["-0", "1", "1"], 2))
        self.assertFalse(core.verify_triple(["1", "2", "3"], 35))
        self.assertTrue(core.verify_triple(["1", "2", "3"], 36))

    def test_task_execution_and_digest(self):
        task = core.make_task("c00", "0", 0)
        self.assertEqual(core.task_id(task), "114-engine-v1:c00:0:0")
        res = core.run_task(task)
        self.assertIn("digest", res)
        self.assertEqual(len(res["digest"]), 64)
        self.assertEqual(res["id"], "114-engine-v1:c00:0:0")
        # Check conservation laws
        c = res["counters"]
        gen_sum = c["outside_shell"] + c["invalid_d"] + c["signed_excluded"] + c["noninvertible"] + c["curves"]
        self.assertEqual(c["generators"], gen_sum)
        q_sum = c["rejected_mod243"] + c["rejected_parity"] + c["rejected_prime"] + c["exact_tests"]
        self.assertEqual(c["quotient_points"], q_sum)
        print("Test task executed successfully:", res["id"], "digest:", res["digest"])


if __name__ == "__main__":
    unittest.main()
