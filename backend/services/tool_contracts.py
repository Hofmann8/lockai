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
# web_search 的引擎和时间范围：模型用这些语义化的名字，services/search.py 负责翻译成 CleverSee 的参数
SEARCH_ENGINES = ["cn_fast", "cn_news", "cn_authority", "global"]
SEARCH_TIME_RANGES = ["day", "week", "month", "year", "any"]
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
                "联网搜索，返回网页标题、来源、发布时间和摘要。实时信息（新闻、天气、赛事、价格、最新数据）"
                "或你不确定的事实时使用。先用默认引擎；结果不够再换引擎或调整参数补搜，不要重复同样的搜索。"
                "同一轮需要多个搜索时一次发出。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "关键词式查询，30 字以内；中文问题用中文关键词"},
                    "engine": {
                        "type": "string",
                        "enum": list(SEARCH_ENGINES),
                        "description": (
                            "cn_fast：默认，中文网页，最快最便宜；"
                            "cn_news：新闻、近期动态等时效性强的中文内容；"
                            "cn_authority：权威来源，并能直接给出天气、时间、汇率、股价、金价等结构化数据，查这些时用它；"
                            "global：英文或海外话题（海外公司、人物、论文、产品），较慢较贵，中文源不够时再用"
                        ),
                    },
                    "time_range": {
                        "type": "string",
                        "enum": list(SEARCH_TIME_RANGES),
                        "description": "限定发布时间，默认 any；global 和 cn_authority 不支持，需要时把年月写进 query",
                    },
                    "sites": {
                        "type": "string",
                        "description": "可选，只搜这些站点，逗号分隔，写具体域名如 www.gov.cn,chinatax.gov.cn（不要只写 gov.cn）",
                    },
                    "full_text": {
                        "type": "boolean",
                        "description": "摘要不够、需要原文细节时设为 true，会附上前几条的正文节选（更慢、上下文更长）",
                    },
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


# 沙箱里的场景说明书：名字 → 什么时候读。文件在 sandbox/skills/，打进沙箱模板的 /opt/lockai/skills/
SANDBOX_SKILLS = (
    ("writing", "论文、报告、策划书、作业等长文档：查证 → 写作 → 排版（LaTeX 出 PDF + todocx 转 Word，或 Markdown 出 Word）"),
    ("slides", "演示文稿（质量优先）：HTML 模板排版，slides2pdf 导出 PDF"),
    ("pptx", "演示文稿（可编辑优先、要能改字的 PPT、改用户的 .pptx）：pptxgenjs / python-pptx"),
    ("docx", "Word：按模板批量生成、通知证书、改用户已有的 Word（成篇文字走 writing）"),
    ("xlsx", "做 Excel 表格、公式、图表、清洗表格数据"),
    ("pdf", "生成排版好的 PDF，合并 / 拆分 / 提取 / 转图片"),
    ("latex", "LaTeX / Typst 排版细节、编译报错、公式、简历"),
    ("charts", "数据分析和出图（中文字体、风格统一）"),
    ("media", "音视频：剪辑、转码、压缩、提取音频、变速、GIF、节拍分析（ffmpeg / librosa）"),
    ("images", "图片处理：格式转换、HEIC、抠图（用预装的 rembg，不要按颜色硬抠）、拼图、压缩、二维码、OCR（rapidocr）"),
    ("web", "做网页 / 小工具 / 前端项目并给出预览"),
    ("schedule", "排期、日程、农历、节假日调休、导出日历文件"),
)


def _build_shell_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "shell",
            "description": (
                "在这个对话专属的 Linux 沙箱里执行 bash 命令（Debian，Python 3.13、Node 22，常用办公 / 媒体 / 排版 / 数据工具都已装好，"
                "国内网络）。用于处理文件、做文档 / 表格 / 幻灯片 / PDF、数据分析出图、音视频和图片处理、写代码并运行、精确计算。"
                "每次调用是新的 shell，工作目录 /home/user，用绝对路径或先 cd。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "这一步在做什么，给用户看的简短标题（用户的语言，15 字以内），如“读取表格结构”“生成第 3 页幻灯片”“检查排版效果”",
                    },
                    "command": {"type": "string", "description": "要执行的 bash 命令；多行脚本用 heredoc 写文件再运行"},
                    "timeout": {"type": "integer", "description": "超时秒数，默认 120，最大 900；装依赖、转码、编译等耗时任务调大"},
                    "background": {
                        "type": "boolean",
                        "description": "常驻进程（开发服务器、预览服务）设为 true，命令会留在后台运行，先返回前几秒的输出",
                    },
                    "port": {"type": "integer", "description": "background 服务监听的端口，填了会返回公网预览地址"},
                    "show": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "执行后要亲眼看的图片路径（png/jpg/webp，最多 4 张），用来检查自己做的幻灯片、图表、排版。命令跑完才读图，可以直接看这条命令刚生成的图片",
                    },
                },
                "required": ["title", "command"],
                "additionalProperties": False,
            },
        },
    }


def build_chat_tools(include_shell: bool = False) -> list[dict[str, Any]]:
    tools = [
        _build_web_search_tool(),
        _build_generate_image_tool(),
        _build_edit_image_tool(),
    ]
    if include_shell:
        tools.append(_build_shell_tool())
    return tools


CHAT_TOOLS = build_chat_tools()
CHAT_TOOLS_WITH_SHELL = build_chat_tools(include_shell=True)
SEARCH_ONLY_TOOLS = [CHAT_TOOLS[0]]


def build_sandbox_instruction() -> str:
    skills = "\n".join(f"  - {name}：{usage}" for name, usage in SANDBOX_SKILLS)
    return f"""`shell` 沙箱使用原则：
1. 需要真正动手的任务才用：处理用户的文件、产出文件（文档 / 表格 / 幻灯片 / PDF / 图片 / 音视频 / 网页）、数据分析、跑代码、精确计算。闲聊、解释概念、写一段文字直接回答，不要开沙箱
2. 目录：/home/user/inputs 是用户上传的附件（上传的文件夹保留原目录结构，聊天里发的图片在 inputs/images/）；/home/user/work 放项目和中间文件；成品写到 /home/user/outputs，每条命令结束后里面新增或改动的文件会自动以文件卡片交付给用户，不要自己贴下载链接，也不要把中间文件放进 outputs
3. 这个对话的 work 和 outputs 会一直保留，用户隔天再来也在；沙箱空闲几分钟会回收，下次自动重建并恢复文件，但后台服务要重新启动，额外装的 pip 包和 node_modules / venv 不会保留，需要时重装（有 package.json / requirements.txt 的话一条命令就好）
4. 开工第一步先 `cat /opt/lockai/skills/<名字>.md` 读对应说明书（可以和查看输入文件合在一条命令里），照里面的经验和预装工具做，不要自己另起炉灶。只读这次用得上的一两份，用到别的场景时再读；一次 cat 太多份会超出输出上限被截断：
{skills}
5. 做出来的幻灯片、文档、图表、排版，先转成图片用 `show` 看一眼（文字溢出、乱码、重叠、空白页），有问题改完再交付。`show` 在命令跑完后才读图，生成图片和查看放在同一次调用里
6. 中文字体用 Noto Sans CJK SC / Noto Serif CJK SC；pip / npm 已配国内镜像，GitHub 能连，Hugging Face 走 hf-mirror.com
7. 任务分好几块（大概要 5 步以上）时，先把计划写成清单存到 /home/user/work/PLAN.md，每做完一块就勾掉并记下关键结果（文件名、尺寸、数字）。较早步骤的命令和输出会从上下文里压缩掉，接着做、用户说「继续」时先 cat 它，不要凭印象
8. 一步做一件事，失败了读报错再改，不要盲目重复同一条命令；输出很长时只看关键部分（head / tail / grep）。新文件用 heredoc 写；改已有文件的局部用 `apply_patch`（Codex 补丁格式，`apply_patch --help` 看用法），不要为了改几行把整份文件重写一遍
9. 完成后用一两句话告诉用户做了什么、交付了哪些文件、需要注意什么，不要复述文件内容。文件卡片会自动出现在回复里，不要再用表格或列表把文件清单、路径列一遍，也不要提 outputs、work 这些沙箱目录
10. 给用户看的文字都用用户的语言：调用前那句说明、每一步的 title、最后的总结
11. 要交的长文（论文、报告、策划书、作业等，约 800 字以上）和演示文稿做成排版好的文件交付，格式按下面的「交付偏好」，用户点名要某种格式时以用户为准。先查证、再写作、最后排版自检；同一份文档的 PDF 和 Word 用同一个文件名。回复里给标题、提纲和查证了哪些内容，不必把全文再贴一遍"""


SANDBOX_INSTRUCTION = build_sandbox_instruction()



def _build_delegate_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "delegate",
            "description": (
                "把一块具体的执行工作交给执行助手，在同一个沙箱里做完（写代码、生成文件、处理数据、反复调试）。"
                "它看不到对话，只看你写的任务说明；做完交回一份简短报告（做了什么、交付了哪些文件、关键数字、遗留问题）。"
                "一次交一块，等报告回来再交下一块。看文件、show 检查成品这类一两条命令的事自己用 shell。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "这块工作的简短名字，给用户看，比如「票务数据」「赞助提案 PPT」"},
                    "task": {
                        "type": "string",
                        "description": (
                            "完整的任务说明，要自成一体：目标；输入（文件路径、数据口径）；要产出的文件名和格式；"
                            "具体规格和要用的文案（文案、配色、版式由你定好写进来）；验收标准（它该怎么自检）。"
                        ),
                    },
                },
                "required": ["title", "task"],
                "additionalProperties": False,
            },
        },
    }


# 统筹模型（models.json 里配了 delegate_to 的）多一个派活的工具；执行助手只有 shell
DELEGATE_TOOL = _build_delegate_tool()
WORKER_TOOLS = [_build_shell_tool()]

DELEGATE_INSTRUCTION = """分工：你是统筹者，底下有一位执行助手，用 `delegate` 给它派活。
1. 你负责：弄清需求；拆成几块工作；定下要紧的内容和设计（文案、措辞、配色、版式、数据口径）；验收；写给用户的最终回答
2. 步骤多、要写代码和反复调试的活交给 `delegate`，一块一个任务，等报告回来再派下一块；看文件、用 show 检查成品这类一两条命令的事自己用 shell
3. 任务说明要自成一体，执行助手看不到对话：写清目标、输入、产出文件名、规格、验收标准。几块工作共用的约定（配色、文案、数据口径、文件命名）先写进 /home/user/work/PLAN.md，并在说明里让它先读
4. 报告回来后，关键成品转成图片用 shell 的 `show` 亲眼看一下；不满意就再派一次，写清哪里要改、改成什么样
5. 一问一答、一两步就能做完的事不用派活，直接做"""

WORKER_INSTRUCTION = """你是执行助手：统筹者把一块具体工作交给你，你在沙箱里把它做完。
- 只做任务说明里的事，文件名、格式、规格、文案照说明来；说明里让你先读 PLAN.md 的就先读
- 下面沙箱原则里说的「告诉用户」，对你来说是向统筹者汇报
- 做完用几行写报告（给统筹者看，不寒暄、不复述文件内容）：做了什么；交付了哪些文件（outputs 下的路径）；关键数字；没做完或拿不准的地方；建议统筹者用 show 查看的预览图路径（没有就不写）"""

# 用户在设置里选的交付偏好：排版质量优先（默认）/ 方便编辑优先
DELIVERY_PREFERENCES = {
    "quality": (
        "交付偏好：排版质量优先。长文档用 LaTeX 排版出 PDF，再用 `todocx` 从源文件转一份 Word（见 writing.md）；"
        "演示文稿用 HTML 模板排版、`slides2pdf` 导出 PDF（见 slides.md），用户要 PPT 文件时加 `--pptx` 出图片版并说明不能改字。"
    ),
    "editable": (
        "交付偏好：方便编辑优先。长文档写 Markdown 用 `todocx` 出 Word，再转一份 PDF（见 writing.md 路线 B）；"
        "演示文稿用 pptxgenjs 做可编辑的 PPTX，再转一份 PDF（见 pptx.md）。"
    ),
}


def delivery_preference(mode: str | None) -> str:
    return DELIVERY_PREFERENCES.get(str(mode or "").strip().lower(), DELIVERY_PREFERENCES["quality"])


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
- 调用工具前可以用一句简短的话说明这一步要做什么（例如"我查一下杭州今天的天气"），界面会把它收进工具卡片；用和用户相同的语言，不超过一句，不要寒暄；拿到结果后直接给答案
- 用户用中文提问时，搜索关键词也用中文；只有查询对象本身是英文资料时才用英文
- 思考阶段只做规划（结构、要点、要查证什么），不要在思考里把正文写一遍，正文留到回答里写
- 写论文、报告、综述、调研这类要拿去交或发表的文章时，先用 `web_search` 核实文中要用的事实、数据、政策原文、人物观点和参考文献；参考文献只列查到的真实文献（作者、题名、出处、年份对得上），查不到就不列，绝不编造

`web_search` 使用原则：
1. 如果预计需要多个搜索，请在同一轮一次性发出多个 `web_search` 调用
2. 搜索结果返回后默认直接回答，只有仍有明确缺口时才继续搜索
3. 不要为了翻译、同义改写或轻微换词重复搜索；要补搜就换 `engine`、`time_range`、`sites` 或换个角度的关键词
4. 天气、时间、汇率、股价、金价直接用 `engine="cn_authority"`，它会返回结构化数据，优先采用
5. 之前轮次的搜索结果不会保留在上下文里；追问涉及新的数据（另一天、另一个地方、最新变化）时重新搜索，不要凭记忆补

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
