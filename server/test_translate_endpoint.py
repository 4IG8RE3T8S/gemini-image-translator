# server/test_translate_endpoint.py
import unittest
import json
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from server.main import app, VALID_TOKENS

class TestTranslateEndpoint(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)
        self.token = "dev-token-secret-68310545"
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def test_health_check(self):
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    @patch("server.main.urllib.request.urlopen")
    @patch("server.main.GEMINI_API_KEY", "dummy_key_1234567890")
    def test_translate_normal_streaming_flow(self, mock_urlopen):
        # Construct proper SSE chunks
        chunk1 = {"candidates": [{"content": {"parts": [{"text": '[{"box_2d": [10, 20, 30, 40], '}]}}]}
        chunk2 = {"candidates": [{"content": {"parts": [{"text": '"text": "Hello", "translated_text": "สวัสดี"}'}]}}]}
        chunk3 = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "]"}]}}]}

        sse_lines = [
            f"data: {json.dumps(chunk1)}\n".encode("utf-8"),
            f"data: {json.dumps(chunk2)}\n".encode("utf-8"),
            f"data: {json.dumps(chunk3)}\n".encode("utf-8"),
            b"data: [DONE]\n"
        ]
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = sse_lines
        mock_urlopen.return_value = mock_resp

        payload = {
            "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "targetLang": "Thai",
            "model": "gemini-2.0-flash",
            "stream": True
        }
        res = self.client.post("/api/translate", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["segments"]), 1)
        self.assertEqual(data["segments"][0]["text"], "Hello")
        self.assertEqual(data["finishReason"], "STOP")

    @patch("server.main.urllib.request.urlopen")
    @patch("server.main.GEMINI_API_KEY", "dummy_key_1234567890")
    def test_translate_truncated_max_tokens_flow(self, mock_urlopen):
        # Simulate SSE response cut off due to MAX_TOKENS (missing closing brackets '}]')
        sse_lines = [
            b'data: {"candidates": [{"content": {"parts": [{"text": "[ { \\"box_2d\\": [33, 36, 0, 195], \\"text\\": \\"ASURASCANS.COM\\", \\"translated_text\\": \\"ASURASCANS.COM\\""}]}}]}\n',
            b'data: {"candidates": [{"finishReason": "MAX_TOKENS"}]}\n',
            b'data: [DONE]\n'
        ]
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = sse_lines
        mock_urlopen.return_value = mock_resp

        payload = {
            "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "targetLang": "Thai",
            "model": "gemini-2.0-flash",
            "stream": True
        }
        res = self.client.post("/api/translate", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["finishReason"], "MAX_TOKENS")
        self.assertEqual(len(data["segments"]), 1)
        self.assertEqual(data["segments"][0]["text"], "ASURASCANS.COM")

    @patch("server.main.urllib.request.urlopen")
    @patch("server.main.GEMINI_API_KEY", "dummy_key_1234567890")
    def test_translate_safety_filter_blocks(self, mock_urlopen):
        sse_lines = [
            b'data: {"candidates": [{"finishReason": "SAFETY"}]}\n',
            b'data: [DONE]\n'
        ]
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = sse_lines
        mock_urlopen.return_value = mock_resp

        payload = {
            "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "targetLang": "Thai"
        }
        res = self.client.post("/api/translate", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 400)
        self.assertIn("Safety Filter", res.json()["detail"])

if __name__ == "__main__":
    unittest.main()
