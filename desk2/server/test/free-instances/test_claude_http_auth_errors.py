"""No-network auth classification: browser challenges do not prove session revocation."""

import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from claudfree.http import ClaudeHttp, HttpError, model_refusal


class Response:
    def __init__(self, status, body=b"", content_type="application/json"):
        self.status_code = status
        self.headers = {"content-type": content_type}
        self.body = body
        self.close = Mock()
        self.reads = 0

    def iter_content(self, size):
        self.reads += 1
        if self.reads != 1:
            raise AssertionError("A streamed refusal must be read only once")
        for start in range(0, len(self.body), size):
            yield self.body[start:start + size]


def refusal(code, message="Synthetic refusal"):
    return json.dumps({"error": {"type": "permission_error", "message": message,
        "details": {"error_code": code}}}).encode()


class ClaudeHTTPAuthErrorsTests(unittest.TestCase):
    def request_error(self, response):
        client = object.__new__(ClaudeHttp)
        client.timeout = 5
        client.session = SimpleNamespace(request=Mock(return_value=response))
        with self.assertRaises(HttpError) as caught:
            client._request("GET", "/api/organizations")
        response.close.assert_called_once_with()
        self.assertFalse(client.session.request.call_args.kwargs["allow_redirects"])
        self.assertEqual(caught.exception.status, response.status_code)
        return caught.exception

    def test_only_unauthorized_or_explicit_invalid_session_proves_expiration(self):
        for response in [Response(401), Response(403, refusal("account_session_invalid"))]:
            with self.subTest(status=response.status_code):
                self.assertEqual(self.request_error(response).code, "login_expired")

    def test_generic_forbidden_redirects_and_challenges_preserve_auth_state(self):
        responses = [
            Response(403, b"<html>Cloudflare verification</html>", "text/html"),
            Response(403, refusal("browser_verification_required")),
            Response(403, b'{"error":{"type":"permission_error"}}'),
            Response(403, b"not json"),
            Response(403, b'{"error":{"details":"account_session_invalid"}}'),
            Response(403, b'{"error":{"message":"account_session_invalid"}}'),
            Response(403, b" " * 65537 + refusal("account_session_invalid")),
            Response(302), Response(307),
        ]
        for response in responses:
            with self.subTest(status=response.status_code, body=response.body[:80]):
                error = self.request_error(response)
                self.assertEqual(error.code, "verification_required")
                self.assertNotIn("Cloudflare", str(error))

    def test_model_refusal_retains_its_distinct_code_and_bounded_provider_message(self):
        response = Response(403, refusal("model_not_available", "  Synthetic model unavailable  "))
        error = self.request_error(response)
        self.assertEqual(error.code, "model_not_available")
        self.assertEqual(str(error), "Synthetic model unavailable")
        self.assertEqual(response.reads, 1)
        self.assertEqual(model_refusal(Response(403, refusal("model_not_available"))), "Synthetic refusal")


if __name__ == "__main__":
    unittest.main()
