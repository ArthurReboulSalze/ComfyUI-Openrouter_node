import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class _FakeTensor:
    pass


fake_torch = types.ModuleType("torch")
fake_torch.Tensor = _FakeTensor
fake_torch.float32 = "float32"
fake_torch.zeros = lambda *args, **kwargs: _FakeTensor()
sys.modules.setdefault("torch", fake_torch)

REPOSITORY_PARENT = str(Path(__file__).resolve().parents[2])
if REPOSITORY_PARENT not in sys.path:
    sys.path.insert(0, REPOSITORY_PARENT)

node_module = importlib.import_module("ComfyUI_OpenRouter.node")
OpenRouterNode = node_module.OpenRouterNode


class OpenRouterNodeSettingsTests(unittest.TestCase):
    def setUp(self):
        self.node = OpenRouterNode.__new__(OpenRouterNode)

    def test_upstream_reasoning_and_timeout_inputs_are_available(self):
        catalog = node_module.OpenRouterCatalog
        with (
            patch.object(OpenRouterNode, "fetch_unified_models", return_value=["vendor/chat"]),
            patch.object(catalog, "fetch_chat_widget_capabilities", return_value={}),
            patch.object(catalog, "fetch_image_widget_capabilities", return_value={}),
            patch.object(catalog, "fetch_video_widget_capabilities", return_value={}),
            patch.object(catalog, "fetch_video_resolution_options", return_value=["auto"]),
            patch.object(catalog, "fetch_video_aspect_ratio_options", return_value=["auto"]),
            patch.object(catalog, "fetch_video_duration_options", return_value=["auto"]),
        ):
            required = OpenRouterNode.INPUT_TYPES()["required"]
        self.assertEqual(required["reasoning_effort"][1]["default"], "auto")
        self.assertEqual(required["request_timeout"][1]["default"], 120)
        self.assertEqual(OpenRouterNode.validate_request_timeout("0"), 1)
        self.assertEqual(OpenRouterNode.validate_request_timeout("99999"), 3600)
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("HIGH"), "high")
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("invalid"), "auto")

    def test_chat_request_sends_reasoning_and_configured_timeout(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{"message": {"content": "ok"}}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 1},
        }

        with (
            patch.object(node_module.requests, "post", return_value=response) as post,
            patch.object(self.node, "fetch_credits", return_value="Remaining: $1"),
            patch.object(self.node, "count_tokens", return_value=1),
        ):
            result = self.node._generate_chat(
                api_key="test-key",
                model="vendor/chat",
                seed=1,
                system_prompt="system",
                user_message_box="hello",
                image_generation_only=False,
                web_search=False,
                cheapest=False,
                fastest=False,
                aspect_ratio="auto",
                image_resolution="1K",
                temperature=1.0,
                pdf_engine="auto",
                chat_mode=False,
                reasoning_effort="high",
                request_timeout=7,
            )

        self.assertEqual(result[0], "ok")
        self.assertEqual(post.call_args.kwargs["timeout"], 7)
        self.assertEqual(post.call_args.kwargs["json"]["reasoning"], {"effort": "high"})


if __name__ == "__main__":
    unittest.main()
