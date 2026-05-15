from services.tool_contracts import (
    CHAT_TOOLS,
    IMAGE_ASPECT_RATIOS,
    IMAGE_SIZES,
    TOOL_CALLING_INSTRUCTION,
)


def test_generate_image_contract_exposes_supported_sizes_and_ratios():
    generate_tool = next(tool for tool in CHAT_TOOLS if tool["function"]["name"] == "generate_image")
    image_config = generate_tool["function"]["parameters"]["properties"]["imageConfig"]["properties"]

    assert image_config["aspectRatio"]["enum"] == IMAGE_ASPECT_RATIOS
    assert image_config["imageSize"]["enum"] == IMAGE_SIZES
    assert "4K" in image_config["imageSize"]["description"]
    assert "更高清" in generate_tool["function"]["description"]


def test_tool_instruction_includes_progressive_disclosure_and_high_quality_example():
    assert "渐进式披露" in TOOL_CALLING_INSTRUCTION
    assert "0.5K / 1K / 2K / 4K" in TOOL_CALLING_INSTRUCTION
    assert '"imageSize":"4K"' in TOOL_CALLING_INSTRUCTION
