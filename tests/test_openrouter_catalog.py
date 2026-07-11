import unittest
from unittest.mock import patch

import requests

from openrouter_catalog import OpenRouterCatalog


class OpenRouterCatalogTests(unittest.TestCase):
    def setUp(self):
        OpenRouterCatalog._all_models_cache = None
        OpenRouterCatalog._all_models_timestamp = 0.0
        OpenRouterCatalog._image_models_cache = None
        OpenRouterCatalog._image_models_timestamp = 0.0
        OpenRouterCatalog._video_models_cache = None
        OpenRouterCatalog._video_models_timestamp = 0.0

    def test_force_refresh_bypasses_valid_cache_and_keeps_stale_data_on_error(self):
        stale = [{"id": "vendor/stale", "architecture": {"output_modalities": ["text"]}}]
        OpenRouterCatalog._all_models_cache = stale
        OpenRouterCatalog._all_models_timestamp = 10**12

        with patch.object(
            OpenRouterCatalog,
            "_fetch_json",
            side_effect=requests.exceptions.ConnectionError("offline"),
        ) as fetch:
            self.assertIs(OpenRouterCatalog.fetch_all_models(force_refresh=True), stale)

        fetch.assert_called_once_with(OpenRouterCatalog.MODELS_URL)

    def test_dedicated_image_catalog_is_the_source_of_truth(self):
        general = [
            {"id": "vendor/chat", "architecture": {"output_modalities": ["text"]}},
            # This legacy entry is misclassified in the general catalog.
            {"id": "vendor/legacy-image", "architecture": {"output_modalities": ["text"]}},
        ]
        images = [
            {"id": "vendor/legacy-image", "architecture": {"output_modalities": ["image"]}},
            {"id": "vendor/image-chat", "architecture": {"output_modalities": ["image", "text"]}},
        ]
        OpenRouterCatalog._all_models_cache = general
        OpenRouterCatalog._all_models_timestamp = 10**12
        OpenRouterCatalog._image_models_cache = images
        OpenRouterCatalog._image_models_timestamp = 10**12

        self.assertEqual(
            OpenRouterCatalog.fetch_image_generation_model_ids(),
            ["vendor/image-chat", "vendor/legacy-image"],
        )
        capabilities = OpenRouterCatalog.fetch_image_widget_capabilities()
        self.assertTrue(capabilities["vendor/legacy-image"]["is_image_only"])
        self.assertFalse(capabilities["vendor/image-chat"]["is_image_only"])
        self.assertTrue(
            OpenRouterCatalog.fetch_chat_widget_capabilities()["vendor/legacy-image"]
            ["supports_image_generation"]
        )
        self.assertEqual(
            OpenRouterCatalog._extract_output_modalities(
                OpenRouterCatalog.get_chat_model_by_id("vendor/legacy-image")
            ),
            ["image"],
        )

    def test_build_widget_catalog_refreshes_all_three_endpoints(self):
        responses = {
            OpenRouterCatalog.MODELS_URL: {
                "data": [{"id": "vendor/chat", "architecture": {"output_modalities": ["text"]}}]
            },
            OpenRouterCatalog.IMAGE_MODELS_URL: {
                "data": [{"id": "vendor/image", "architecture": {"output_modalities": ["image"]}}]
            },
            OpenRouterCatalog.VIDEO_MODELS_URL: {
                "data": [{"id": "vendor/video", "supported_durations": [5]}]
            },
        }

        with patch.object(OpenRouterCatalog, "_fetch_json", side_effect=lambda url: responses[url]) as fetch:
            catalog = OpenRouterCatalog.build_widget_catalog(force_refresh=True)

        self.assertEqual(fetch.call_count, 3)
        self.assertEqual(catalog["counts"]["image"], 1)
        self.assertEqual(catalog["counts"]["video"], 1)
        self.assertIn("vendor/image", catalog["models"])
        self.assertIn("vendor/video", catalog["models"])

    def test_estimates_cents_per_second_video_pricing(self):
        model = {
            "supported_resolutions": ["480p", "720p"],
            "pricing_skus": {
                "cents_per_image_input": "0.2",
                "cents_per_video_output_second_480p": "5",
                "cents_per_video_output_second_720p": "7",
            },
        }
        payload = {
            "duration": 6,
            "resolution": "720p",
            "frame_images": [{"frame_type": "first_frame"}],
        }

        estimate = OpenRouterCatalog.estimate_video_cost(model, payload, "image_to_video")

        self.assertEqual(estimate["pricing_mode"], "cents_per_video_output_second")
        self.assertEqual(estimate["image_input_count"], 1)
        self.assertAlmostEqual(estimate["min_cost_usd"], 0.422)
        self.assertEqual(estimate["display_text"], "$0.4220")


if __name__ == "__main__":
    unittest.main()
