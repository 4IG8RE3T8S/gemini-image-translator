# server/test_resilient_json.py
import unittest
import json
from server.main import (
    repair_and_parse_json,
    clean_and_extract_json,
    TranslateRequest,
    TranslateResponse,
    _auto_repair_json_string
)

class TestResilientJsonParser(unittest.TestCase):

    def test_translate_request_default_max_output_tokens(self):
        req = TranslateRequest(base64="abc")
        self.assertGreaterEqual(req.max_output_tokens, 4096)
        self.assertEqual(req.max_output_tokens, 8192)

    def test_translate_response_finish_reason_field(self):
        resp = TranslateResponse(
            success=True,
            segments=[],
            targetLang="Thai",
            model="gemini-2.0-flash",
            finishReason="MAX_TOKENS"
        )
        self.assertEqual(resp.finishReason, "MAX_TOKENS")

    def test_normal_complete_json(self):
        raw = '[{"box_2d": [10, 20, 30, 40], "text": "Hello", "translated_text": "สวัสดี"}]'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "Hello")
        self.assertEqual(res[0]["translated_text"], "สวัสดี")
        self.assertEqual(res[0]["box_2d"], [10, 20, 30, 40])

    def test_markdown_fence_complete(self):
        raw = '```json\n[{"box_2d": [10, 20, 30, 40], "text": "Hello", "translated_text": "สวัสดี"}]\n```'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "Hello")

    def test_markdown_fence_truncated_unclosed(self):
        raw = '```json\n[{"box_2d": [10, 20, 30, 40], "text": "Hello", "translated_text": "สวัสดี"}]'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "Hello")

    def test_symptom_2_missing_closing_braces(self):
        # Truncated without closing }]
        raw = '[ { "box_2d": [33, 36, 0, 195], "text": "ASURASCANS.COM", "translated_text": "ASURASCANS.COM"'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "ASURASCANS.COM")
        self.assertEqual(res[0]["translated_text"], "ASURASCANS.COM")
        self.assertEqual(res[0]["box_2d"], [33, 36, 0, 195])

    def test_symptom_1_truncated_mid_key(self):
        # Truncated mid-key
        raw = '[ { "box_2d": [113, 176, 277, 448], "text": "...UGH,\\nALMOST BUSTED\\nMY NOSE.", "translated_te'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["box_2d"], [113, 176, 277, 448])
        self.assertIn("ALMOST BUSTED", res[0]["text"])
        # Fallback translated_text should match text
        self.assertIn("ALMOST BUSTED", res[0]["translated_text"])

    def test_truncated_mid_string_value(self):
        raw = '[ { "box_2d": [113, 176, 277, 448], "text": "Ouch", "translated_text": "โอ๊ย เจ็บ'
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "Ouch")
        self.assertEqual(res[0]["translated_text"], "โอ๊ย เจ็บ")

    def test_truncated_at_colon(self):
        raw = '[ { "box_2d": [113, 176, 277, 448], "text": "Ouch", "translated_text": '
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "Ouch")

    def test_multiple_items_with_truncated_last_item(self):
        raw = (
            '[\n'
            '  {"box_2d": [10, 20, 30, 40], "text": "First", "translated_text": "อันแรก"},\n'
            '  {"box_2d": [50, 60, 70, 80], "text": "Second", "translated_te\n'
        )
        res = repair_and_parse_json(raw)
        self.assertGreaterEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "First")
        self.assertEqual(res[0]["translated_text"], "อันแรก")

    def test_multiple_items_with_severely_mangled_last_item(self):
        raw = (
            '[\n'
            '  {"box_2d": [10, 20, 30, 40], "text": "First", "translated_text": "อันแรก"},\n'
            '  {"box_2d": [50, 60\n'
        )
        res = repair_and_parse_json(raw)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["text"], "First")

    def test_empty_array(self):
        raw = "[]"
        res = repair_and_parse_json(raw)
        self.assertEqual(res, [])

    def test_empty_string(self):
        res = repair_and_parse_json("")
        self.assertEqual(res, [])

if __name__ == "__main__":
    unittest.main()
