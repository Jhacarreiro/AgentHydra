"""No-network check that a ChatGPT login's cookie jar stays small however many Temporary Chats it made."""

import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import requests

from claudfree.chatgpt.http import PER_CHAT_COOKIES_KEPT, ChatGPTHttp
from claudfree.errors import ClaudeError


def cookie(name, expires, value="v"):
    return {"name": name, "value": value, "domain": ".chatgpt.com", "path": "/", "expires": expires}


class ChatGPTCookieJarTests(unittest.TestCase):
    def test_auth_and_temporary_chat_read_keep_all_applicable_credentials(self):
        chat = str(uuid4())
        now = time.time()
        jar = [cookie(n, now + 3600, n + "-value") for n in (
            "__Secure-next-auth.session-token.0", "__Secure-next-auth.session-token.1",
            "_uasid", "_umsid", "oai-did", "conv_key_" + chat)]
        jar += [{**cookie("auth-only", now + 3600), "domain": "auth.openai.com"},
                cookie("expired", now - 1), cookie("history_off_" + chat, now + 3600, "0")]
        http = ChatGPTHttp({"cookies": jar})
        headers = []
        def respond(request, **kwargs):
            headers.append(request.headers.get("Cookie", ""))
            response = requests.Response()
            response.status_code = 200
            response._content = (b'{"user":{"id":"example"},"accessToken":"fixture"}'
                if request.url.endswith("/api/auth/session") else
                ('{"conversation_id":"' + chat + '","is_temporary_chat":true}').encode())
            return response
        try:
            with patch.object(http.session, "send", side_effect=respond):
                http.authenticate()
                http.read(chat)
            for sent in headers:
                for entry in jar[:6]:
                    self.assertIn(entry["name"] + "=" + entry["value"], sent)
                self.assertNotIn("auth-only", sent)
                self.assertNotIn("expired", sent)
            self.assertIn("history_off_" + chat + "=1", headers[1])
            self.assertEqual(headers[1].count("history_off_" + chat + "="), 1)
            self.assertEqual(next(c.value for c in http.session.cookies if c.name == "history_off_" + chat), "0")
        finally:
            http.close()

    def test_generation_model_refusal_is_not_misreported_as_expired_chat(self):
        http = ChatGPTHttp({"cookies": []})
        response = requests.Response()
        response.status_code = 404
        response._content = b'{"detail":"Model not found"}'
        try:
            with patch.object(http.session, "send", return_value=response):
                with self.assertRaises(ClaudeError) as caught:
                    http._request("POST", "/backend-api/f/conversation", json={})
            self.assertEqual(caught.exception.code, "model_not_found")
            self.assertNotIn("chat may also have expired", str(caught.exception))
        finally:
            http.close()

    def test_a_jar_from_hundreds_of_chats_loads_and_saves_only_the_newest_per_chat_cookies(self):
        # 2026-10-07: ~370 chats left ~760 per-chat cookies (~62 KB) and ChatGPT refused every request.
        now = time.time()
        chats = [(uuid4(), now + 86_400 + i) for i in range(400)]
        saved = {
            "cookies": [cookie("__Secure-next-auth.session-token", now + 86_400 * 30, "session")]
            + [cookie(f"conv_key_{chat}", at) for chat, at in chats]
            + [cookie(f"history_off_{chat}", at) for chat, at in chats],
            "origins": [],
        }
        http = ChatGPTHttp(saved)
        sent = {c.name for c in http.session.cookies}
        self.assertIn("__Secure-next-auth.session-token", sent)
        newest = {str(chat) for chat, _ in chats[-PER_CHAT_COOKIES_KEPT:]}
        self.assertEqual({n.split("_", 2)[-1] for n in sent if n.startswith("conv_key_")}, newest)
        self.assertEqual({n.split("_", 2)[-1] for n in sent if n.startswith("history_off_")}, newest)
        written = [c["name"] for c in http.saved_state()["cookies"]]
        self.assertEqual(len(written), 1 + 2 * PER_CHAT_COOKIES_KEPT)
        http.close()


if __name__ == "__main__":
    unittest.main()
