"""
Canonical tool contracts shared by prompts, runtimes and validation.
"""

from __future__ import annotations

from typing import Any


IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]
DEFAULT_IMAGE_ASPECT_RATIO = "1:1"
IMAGE_SIZES = ["0.5K", "1K", "2K", "4K"]
DEFAULT_IMAGE_SIZE = "2K"
IMAGE_EDIT_SOURCE_SCOPES = ["current_upload", "latest_tool_image", "latest_user_upload", "latest_any"]
IMAGE_PROMPT_FIELDS = (
    ("details", "Details"),
    ("style", "Style"),
    ("composition", "Composition"),
    ("camera", "Camera / shot"),
    ("lighting", "Lighting"),
    ("colorTone", "Color tone"),
    ("background", "Background"),
    ("textOverlay", "Text to include"),
)


def _build_web_search_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "搜索互联网获取最新信息，当用户询问新闻、天气、赛事、股价、最新数据等实时内容时使用。"
                "如果预计需要多个搜索，请在同一轮一次性发出多个 web_search 调用。"
                "搜索结果返回后默认直接回答，只有存在明确缺口时才继续搜索。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词或完整查询语句"}
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    }


def _build_generate_image_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": (
                "根据描述生成新图片。优先把需求拆成结构化字段，不要把所有信息都压成一个长 prompt。"
                "若需要让生成结果参考某些已有图片（例如保留某种风格、构图、人物或物体特征，但要重新创作画面），"
                "可通过 referenceImageIds 传入会话资源清单中的 assetId（最多 4 张）；"
                "若用户的意图是在原图上做修改（保留原画面，只改局部或属性），应改用 edit_image 而不是 generate_image。"
                f"已知 imageConfig.aspectRatio 支持 {', '.join(IMAGE_ASPECT_RATIOS)}；"
                f"imageConfig.imageSize 支持 {' / '.join(IMAGE_SIZES)}；"
                f"默认 aspectRatio={DEFAULT_IMAGE_ASPECT_RATIO}、imageSize={DEFAULT_IMAGE_SIZE}。"
                "如果用户明确要求更高清、更高分辨率、清晰度越高越好、最高质量等，应优先选择 4K。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "必填，画面的核心主体或场景"},
                    "details": {"type": "string", "description": "补充细节，例如元素、动作、材质、环境、时代特征"},
                    "style": {"type": "string", "description": "画风或表现形式，例如写实、插画、3D、像素风、水彩"},
                    "composition": {"type": "string", "description": "构图要求，例如特写、全景、居中构图、俯视图"},
                    "camera": {"type": "string", "description": "镜头或视角，例如 macro、wide shot、isometric、top-down"},
                    "lighting": {"type": "string", "description": "光线和氛围，例如 cinematic lighting、soft daylight、misty rain"},
                    "colorTone": {"type": "string", "description": "色调要求，例如 warm、cool、pastel、high contrast"},
                    "background": {"type": "string", "description": "背景要求"},
                    "textOverlay": {"type": "string", "description": "画面中必须出现的文字；没有则不要填写"},
                    "negativePrompt": {"type": "string", "description": "明确不要出现的内容、缺陷或风格"},
                    "prompt": {"type": "string", "description": "仅用于无法拆成结构化字段的额外补充"},
                    "referenceImageIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "参考图的 assetId 数组，来自会话资源清单；最多 4 张。仅用于让模型借鉴风格/构图/主体特征来创作新画面，不会保留原图内容。",
                    },
                    "referenceUsage": {
                        "type": "string",
                        "description": "说明每张参考图的作用，例如 '第一张提供主体外观，第二张提供光照风格'。仅在传了 referenceImageIds 时填写。",
                    },
                    "imageConfig": {
                        "type": "object",
                        "properties": {
                            "aspectRatio": {
                                "type": "string",
                                "enum": IMAGE_ASPECT_RATIOS,
                                "description": f"宽高比，支持 {', '.join(IMAGE_ASPECT_RATIOS)}；默认 {DEFAULT_IMAGE_ASPECT_RATIO}",
                            },
                            "imageSize": {
                                "type": "string",
                                "enum": IMAGE_SIZES,
                                "description": (
                                    f"清晰度档位，支持 {' / '.join(IMAGE_SIZES)}；默认 {DEFAULT_IMAGE_SIZE}。"
                                    "用户明确要求更高清、最高质量、清晰度越高越好时优先选 4K"
                                ),
                            },
                        },
                        "additionalProperties": False,
                        "description": "图片生成配置",
                    },
                    "size": {
                        "type": "string",
                        "enum": ["1024x1024", "1536x1024", "1024x1536"],
                        "description": "兼容旧参数；如可用，优先改用 imageConfig.aspectRatio",
                    },
                },
                "required": ["subject"],
                "additionalProperties": False,
            },
        },
    }


def _build_edit_image_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "edit_image",
            "description": (
                "编辑已有图片。当用户要求修改、重绘、扩图、替换背景、加元素、改文字或改颜色，"
                "并且目标是当前上传的图片或会话里已经出现过的图片时使用。"
                "优先编辑现有图片，不要误用 generate_image 重新从零生成。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {"type": "string", "description": "必填，对原图要进行的修改"},
                    "sourceImageId": {"type": "string", "description": "优先使用，会话资源清单中的唯一图片 ID；已知精确目标时必须填写"},
                    "sourceScope": {
                        "type": "string",
                        "enum": IMAGE_EDIT_SOURCE_SCOPES,
                        "description": "图片来源范围；当前上传用 current_upload，上一张模型产图用 latest_tool_image，用户历史上传图用 latest_user_upload，不确定时用 latest_any",
                    },
                    "sourceHint": {"type": "string", "description": "用于定位图片，例如“刚上传的显微镜图”“上一张蓝色海报”"},
                    "sourceIndex": {"type": "integer", "description": "1 开始计数；当用户明确说“第一张/第二张”时填写"},
                    "preserve": {"type": "string", "description": "需要明确保留的内容，例如主体身份、构图、文字布局"},
                    "negativePrompt": {"type": "string", "description": "明确不要出现的内容、缺陷或风格"},
                    "imageConfig": {
                        "type": "object",
                        "properties": {
                            "aspectRatio": {
                                "type": "string",
                                "enum": IMAGE_ASPECT_RATIOS,
                                "description": f"目标宽高比，支持 {', '.join(IMAGE_ASPECT_RATIOS)}；不填则由系统自动继承原图画布比例",
                            },
                            "imageSize": {
                                "type": "string",
                                "enum": IMAGE_SIZES,
                                "description": f"清晰度档位，支持 {' / '.join(IMAGE_SIZES)}；用户明确要求更高清时可选 4K",
                            },
                        },
                        "additionalProperties": False,
                        "description": "图片编辑配置",
                    },
                },
                "required": ["instruction"],
                "additionalProperties": False,
            },
        },
    }


def build_chat_tools() -> list[dict[str, Any]]:
    return [
        _build_web_search_tool(),
        _build_generate_image_tool(),
        _build_edit_image_tool(),
    ]


CHAT_TOOLS = build_chat_tools()
SEARCH_ONLY_TOOLS = [CHAT_TOOLS[0]]


def build_anthropic_tools(tools: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    anthropic_tools: list[dict[str, Any]] = []
    for tool in tools or CHAT_TOOLS:
        fn = tool.get("function", {})
        anthropic_tools.append({
            "name": fn.get("name"),
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters", {}),
        })
    return anthropic_tools


def build_tool_calling_instruction() -> str:
    aspect_ratios = "、".join(IMAGE_ASPECT_RATIOS)
    image_sizes = " / ".join(IMAGE_SIZES)
    return f"""工具调用规则：
- 联网搜索、图片生成、图片编辑都必须通过系统提供的工具完成，不要输出 [SEARCH:...]、[DRAW:...] 等文本协议
- 需要实时信息时调用 `web_search`
- 需要从零生成新图片时调用 `generate_image`
- 需要修改已有图片时优先调用 `edit_image`，不要误用 `generate_image`
- 只填写用户明确表达的信息，不要臆造
- 调用工具前不要先输出"我来搜索一下""I'll search…"之类的旁白，界面会自动显示工具进度；拿到结果后直接给答案
- 用户用中文提问时，搜索关键词也用中文；只有查询对象本身是英文资料时才用英文

`web_search` 使用原则：
1. 如果预计需要多个搜索，请在同一轮一次性发出多个 `web_search` 调用
2. 搜索结果返回后默认直接回答，只有仍有明确缺口时才继续搜索
3. 不要为了翻译、同义改写或轻微换词重复搜索

`generate_image` 使用原则：
1. 先做渐进式披露，至少提供 `subject`
2. 只有用户明确提到风格、构图、镜头、光线、色调、背景、画面文字、负面约束时，才填写对应字段
3. `imageConfig.aspectRatio` 支持 {aspect_ratios}；`imageConfig.imageSize` 支持 {image_sizes}
4. 只有用户明确提到宽高比或清晰度时，才填写 `imageConfig`
5. 如果用户明确要求更高清、更高分辨率、清晰度越高越好、最高质量，应优先使用 `imageConfig.imageSize="4K"`
6. 不要把已经结构化表达过的信息再重复塞进 `prompt`
7. 参考图与编辑的判断：
   - 用户要求"在这张图上改/重绘/扩图/替换/加东西" → 用 `edit_image`，目标是保留原画面
   - 用户要求"参考这张图的风格/构图/主体来画一张新的" → 用 `generate_image` + `referenceImageIds`，目标是创作新画面
   - 例："画一只像这张照片里的狗一样可爱的橘猫" → generate_image + referenceImageIds（主体已变）
   - 例："把这张图里的天空改成日落" → edit_image（保留原画面，只改局部）
8. 传 `referenceImageIds` 时优先从会话资源清单选 assetId，最多 4 张，可在 `referenceUsage` 里说明每张图的作用

`edit_image` 使用原则：
1. `instruction` 必填，只写要对原图做什么修改
2. 如果上下文里已经给了会话资源清单，并且你能明确判断目标图片，优先填写 `sourceImageId`
3. 只有无法精确定位时，才使用 `sourceScope`、`sourceHint`、`sourceIndex`
4. 如果仍然无法确定是哪张图，先追问用户，不要猜；系统不会替你默认挑第一张
5. 只有用户明确要求保留某些内容时，才填写 `preserve`
6. 只有用户明确要求宽高比或清晰度时，才填写 `imageConfig`；未填写时系统会自动沿用源图画布比例

`generate_image` 示例：
最小调用：
{{"subject":"一只戴护目镜的橘猫科学家"}}

高清调用：
{{"subject":"杭州西湖，阴雨天的写实风景画","style":"写实风景画","lighting":"阴天柔光，带有水汽和朦胧氛围","imageConfig":{{"imageSize":"4K"}}}}

完整调用：
{{"subject":"微流控液滴芯片示意图","details":"PDMS chip, inlet channels, droplet generation junction, labeled aqueous and oil phases","style":"clean scientific illustration","composition":"top-down schematic","lighting":"soft neutral lighting","colorTone":"white and cyan","background":"plain white background","textOverlay":"Droplet Generator","negativePrompt":"photorealistic clutter, extra labels, watermark","imageConfig":{{"aspectRatio":"16:9","imageSize":"2K"}}}}"""


TOOL_CALLING_INSTRUCTION = build_tool_calling_instruction()
