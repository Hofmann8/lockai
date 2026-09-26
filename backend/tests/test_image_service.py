import base64

from services.image import ImageService


class _DummyLLM:
    def get_model_config(self, _model_id):
        return {}


class _DummyStorage:
    def upload_image(self, *_args, **_kwargs):
        return None


class _FixtureImageService(ImageService):
    def __init__(self, candidates):
        super().__init__(_DummyLLM(), _DummyStorage())
        self._fixture_candidates = candidates

    def _collect_edit_source_candidates(self, session_id=None, current_user_image_urls=None, current_user_message_id=None):
        return list(self._fixture_candidates)


def test_effective_edit_request_inherits_source_canvas_ratio():
    service = ImageService(_DummyLLM(), _DummyStorage())

    resolved, plan = service._resolve_effective_edit_request(
        {"instruction": "只改背景颜色"},
        {"supportedAspectRatio": "16:9", "aspectRatio": "16:9"},
    )

    assert resolved["imageConfig"]["aspectRatio"] == "16:9"
    assert plan["effectiveAspectRatio"] == "16:9"
    assert plan["preserveSourceCanvas"] is True


def test_effective_edit_request_preserves_explicit_aspect_ratio_override():
    service = ImageService(_DummyLLM(), _DummyStorage())

    resolved, plan = service._resolve_effective_edit_request(
        {"instruction": "改成方图", "imageConfig": {"aspectRatio": "1:1"}},
        {"supportedAspectRatio": "16:9", "aspectRatio": "16:9"},
    )

    assert resolved["imageConfig"]["aspectRatio"] == "1:1"
    assert plan["effectiveAspectRatio"] == "1:1"
    assert plan["preserveSourceCanvas"] is False


def test_resolve_edit_source_candidate_requires_disambiguation_for_multiple_images():
    service = _FixtureImageService([
        {
            "assetId": "asset_tool_a_1",
            "url": "https://example.com/a.png",
            "sourceScope": "latest_tool_image",
            "label": "海报 A",
            "summary": "蓝色海报",
            "searchBlob": "海报 a 蓝色海报",
        },
        {
            "assetId": "asset_tool_b_1",
            "url": "https://example.com/b.png",
            "sourceScope": "latest_tool_image",
            "label": "海报 B",
            "summary": "红色海报",
            "searchBlob": "海报 b 红色海报",
        },
    ])

    candidate, error = service._resolve_edit_source_candidate(
        session_id="session-1",
        edit_request={"instruction": "改一下标题"},
    )

    assert candidate is None
    assert "多张" in error


def test_resolve_edit_source_candidate_prefers_exact_asset_id():
    service = _FixtureImageService([
        {
            "assetId": "asset_tool_a_1",
            "url": "https://example.com/a.png",
            "sourceScope": "latest_tool_image",
            "label": "海报 A",
            "summary": "蓝色海报",
            "searchBlob": "海报 a 蓝色海报",
        },
        {
            "assetId": "asset_tool_b_1",
            "url": "https://example.com/b.png",
            "sourceScope": "latest_tool_image",
            "label": "海报 B",
            "summary": "红色海报",
            "searchBlob": "海报 b 红色海报",
        },
    ])

    candidate, error = service._resolve_edit_source_candidate(
        session_id="session-1",
        edit_request={"instruction": "改一下标题", "sourceImageId": "asset_tool_b_1"},
    )

    assert error is None
    assert candidate["assetId"] == "asset_tool_b_1"


def test_inspect_image_bytes_extracts_png_geometry():
    service = ImageService(_DummyLLM(), _DummyStorage())
    png_bytes = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z5pQAAAAASUVORK5CYII=")

    metadata = service._inspect_image_bytes(png_bytes, "image/png")

    assert metadata["width"] == 1
    assert metadata["height"] == 1
    assert metadata["aspectRatio"] == "1:1"


def test_watermarked_url_uses_oss_processing_scaled_to_image(monkeypatch):
    from services.storage import StorageService, strip_image_processing

    monkeypatch.delenv("S3_ENDPOINT", raising=False)
    storage = StorageService()
    raw = "https://lock-ai.oss-cn-beijing.aliyuncs.com/users/u/images/a.png"

    marked = storage.watermarked_url(raw, 1000, 600)
    assert marked.startswith(raw + "?x-oss-process=image/watermark,image_")
    assert ",g_se,x_30,y_18,t_40" in marked
    mark_b64 = marked.split("image_", 1)[1].split(",", 1)[0]
    assert base64.urlsafe_b64decode(mark_b64 + "=" * (-len(mark_b64) % 4)).decode() == (
        "public/watermark.png?x-oss-process=image/resize,P_15"
    )
    assert storage.watermarked_url(raw, blur=True).endswith("/blur,r_30,s_30")
    # 已经带参数的地址重新加水印时不叠加
    assert storage.watermarked_url(marked, 1000, 600) == marked

    assert strip_image_processing(marked) == raw
    assert strip_image_processing("https://example.com/a.png?token=1") == "https://example.com/a.png?token=1"
