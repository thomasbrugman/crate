import tempfile
import unittest
from pathlib import Path

from common import SHOTS, complete_png, concat_entry, render_options, work_parser


class PipelineOptionsTest(unittest.TestCase):
    def test_resume_rejects_missing_empty_truncated_and_non_png_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'0001.png'
            self.assertFalse(complete_png(path))
            path.touch()
            self.assertFalse(complete_png(path))
            header = bytes.fromhex('89504e470d0a1a0a')
            tail = bytes.fromhex('0000000049454e44ae426082')
            path.write_bytes(header + b'incomplete')
            self.assertFalse(complete_png(path))
            path.write_bytes(b'notapng!' + tail)
            self.assertFalse(complete_png(path))
            path.write_bytes(header + tail)
            self.assertTrue(complete_png(path))

    def test_work_dir_and_model_overrides(self):
        parser = work_parser('test')
        render_options(parser)
        options = parser.parse_args(['work with spaces', '--finish', 'yellow',
                                     '--laptop-screen', 'Display', '--lid-tilt', '0'])
        self.assertEqual(options.work_dir, Path('work with spaces').resolve())
        self.assertEqual((options.finish, options.laptop_screen, options.lid_tilt),
                         ('yellow', 'Display', 0))

    def test_cut_frame_budget(self):
        self.assertEqual(sum(round(s['seconds']*60) for s in SHOTS[:-1]), 1590)
        self.assertEqual(round(SHOTS[-1]['seconds']*60), 240)

    def test_concat_entry_quoting(self):
        for path, expected in [
            (Path('/work dir/clip.mp4'), "file '/work dir/clip.mp4'\n"),
            (Path("/Thomas's cut/clip.mp4"), "file '/Thomas'\\''s cut/clip.mp4'\n"),
            ("a'b'c", "file 'a'\\''b'\\''c'\n"),
            ('', "file ''\n"),
        ]:
            with self.subTest(path=path):
                self.assertEqual(concat_entry(path), expected)


if __name__ == '__main__':
    unittest.main()
