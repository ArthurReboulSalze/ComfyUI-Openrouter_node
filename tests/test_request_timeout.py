import unittest

from .test_node_settings import OpenRouterNode


class RequestTimeoutCompatibilityTests(unittest.TestCase):
    @staticmethod
    def _change_key(reasoning_effort="auto", request_timeout=120):
        return OpenRouterNode.IS_CHANGED(
            api_key="test-key",
            request_type="chat",
            model="openai/gpt-4o",
            seed=0,
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
            reasoning_effort=reasoning_effort,
            request_timeout=request_timeout,
            video_mode="text_to_video",
            video_prompt="",
            video_resolution="auto",
            video_aspect_ratio="auto",
            duration="auto",
            generate_audio=True,
            poll_interval_seconds=30,
            timeout_seconds=900,
            provider_json="",
        )

    def test_request_timeout_is_clamped(self):
        self.assertEqual(OpenRouterNode.validate_request_timeout(0), 1)
        self.assertEqual(OpenRouterNode.validate_request_timeout(99999), 3600)
        self.assertEqual(OpenRouterNode.validate_request_timeout("invalid"), 120)

    def test_reasoning_effort_is_normalized(self):
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("HIGH"), "high")
        self.assertEqual(OpenRouterNode.validate_reasoning_effort("unsupported"), "auto")

    def test_cache_key_tracks_reasoning_and_timeout(self):
        base_key = self._change_key()
        self.assertNotEqual(base_key, self._change_key(reasoning_effort="high"))
        self.assertNotEqual(base_key, self._change_key(request_timeout=45))


if __name__ == "__main__":
    unittest.main()
