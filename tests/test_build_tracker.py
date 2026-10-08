import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_tracker as bt  # noqa: E402


class SimplifyTests(unittest.TestCase):
    def test_keeps_shape_and_closure(self):
        ring = [[0, 0], [1, 0], [1, 0.00001], [1, 1], [0.5, 1.000001], [0, 1], [0, 0]]
        out = bt.simplify_ring(ring, 0.001)
        self.assertEqual(out[0], out[-1])
        self.assertEqual(len(out), 5)

    def test_small_ring_untouched(self):
        ring = [[0, 0], [1, 0], [0, 1], [0, 0]]
        self.assertEqual(bt.simplify_ring(ring, 1), ring)

    def test_multipolygon(self):
        g = {"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]]}
        self.assertEqual(bt.simplify_geometry(g)["type"], "MultiPolygon")


class CountTests(unittest.TestCase):
    def setUp(self):
        self._orig = bt.get_json

    def tearDown(self):
        bt.get_json = self._orig

    def test_count_and_guards(self):
        bt.get_json = lambda u: {"entities": [{"entity": 1, "dataset": "tree"}], "count": 12}
        self.assertEqual(bt.count_in_area("tree", 1), 12)
        bt.get_json = lambda u: {"entities": [{"entity": 1, "dataset": "local-authority"}], "count": 9}
        self.assertIsNone(bt.count_in_area("tree", 1))
        bt.get_json = lambda u: {"__status": 422}
        self.assertEqual(bt.count_in_area("smoke-control-area", 1), 0)
        bt.get_json = lambda u: {"entities": [], "count": 25_000_000}
        self.assertIsNone(bt.count_in_area("tree", 1))


if __name__ == "__main__":
    unittest.main()
