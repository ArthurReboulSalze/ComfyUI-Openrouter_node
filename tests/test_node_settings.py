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
            input_types = OpenRouterNode.INPUT_TYPES()
            required = input_types["required"]
        self.assertEqual(required["reasoning_effort"][1]["default"], "auto")
        self.assertEqual(required["request_timeout"][1]["default"], 120)
        self.assertEqual(OpenRouterNode.validate_request_timeout("0"), 1)
        self.assertEqual(OpenRouterNode.validate_request_timeout("99999"), 3600)
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("HIGH"), "high")
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("invalid"), "auto")
        self.assertIn("user_message_input", input_types["optional"])

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

    def test_linked_prompt_overrides_video_prompt(self):
        with (
            patch.object(self.node, "_resolve_api_key", return_value="test-key"),
            patch.object(self.node, "_generate_video", return_value=("video",)) as generate_video,
        ):
            result = self.node.generate_response(
                api_key="",
                request_type="video",
                model="vendor/video",
                seed=1,
                system_prompt="system",
                user_message_box="chat prompt",
                image_generation_only=False,
                web_search=False,
                cheapest=False,
                fastest=False,
                aspect_ratio="auto",
                image_resolution="1K",
                temperature=1.0,
                pdf_engine="auto",
                chat_mode=False,
                reasoning_effort="auto",
                request_timeout=120,
                video_mode="text_to_video",
                video_prompt="video widget prompt",
                video_resolution="720p",
                video_aspect_ratio="16:9",
                duration="5",
                generate_audio=False,
                poll_interval_seconds=5,
                timeout_seconds=60,
                provider_json="",
                user_message_input="  linked prompt  ",
            )

        self.assertEqual(result, ("video",))
        self.assertEqual(generate_video.call_args.kwargs["video_prompt"], "linked prompt")

    def test_fetch_credits_returns_remaining_balance(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "data": {"total_credits": 20.0, "total_usage": 7.655},
        }

        with patch.object(node_module.requests, "get", return_value=response) as get:
            credits = OpenRouterNode.fetch_credits("test-key", timeout=9)

        self.assertEqual(credits, "Remaining: $12.345")
        self.assertEqual(get.call_args.kwargs["timeout"], 9)


if __name__ == "__main__":
    unittest.main()
