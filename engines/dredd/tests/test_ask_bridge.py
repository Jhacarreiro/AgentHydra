import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from ask import kwargs_for


# A unittest.TestCase so ask-bridge.spec.mjs runs it with the standard library alone (`python -m
# unittest test_ask_bridge`); pytest still collects it as before.
class AskBridgeKwargs(unittest.TestCase):
    def test_auto_gets_profile_no_default_effort(self):
        k = kwargs_for({"prompt": "p", "profile": "decision"})
        assert k["model"] == "auto" and k["profile"] == "decision" and "reasoning_effort" not in k

    def test_pin_wins_and_explicit_effort_kept(self):
        k = kwargs_for({"prompt": "p", "model": "gemini-3.8-flash", "profile": "decision", "reasoning_effort": "high"})
        assert "profile" not in k and k["reasoning_effort"] == "high"
