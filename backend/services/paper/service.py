"""
PaperService — 论文生成主服务
后台线程执行 4 Agent pipeline → 编译 PDF → 持久化
前端通过轮询 /status 获取进度
"""

import os
import json
import threading
from datetime import datetime

from .agents import ResearcherAgent, PlannerAgent, WriterAgent, FormatterAgent
from .latex import get_compiler
from .session import PaperSession, PaperStatus, SessionManager
from services.terminal import paper_events


class PaperService:
    """论文生成主服务：协调 Agent pipeline + LaTeX 编译（后台线程）"""

    def __init__(self, llm_service, storage_service, app=None):
        self.storage = storage_service
        self.compiler = get_compiler()
        self.app = app  # Flask app，用于后台线程的 app_context

        paper_key = os.environ.get("API_KEY_PAPER") or None
        self.researcher = ResearcherAgent(
            llm_service,
            model=os.environ.get("MODEL_PAPER_RESEARCHER") or None,
            api_key=paper_key,
        )
        self.planner = PlannerAgent(
            llm_service,
            model=os.environ.get("MODEL_PAPER_PLANNER") or None,
            api_key=paper_key,
        )
        self.writer = WriterAgent(
            llm_service,
            model=os.environ.get("MODEL_PAPER_WRITER") or None,
            api_key=paper_key,
        )
        self.formatter = FormatterAgent(
            llm_service,
            model=os.environ.get("MODEL_PAPER_FORMATTER") or None,
            api_key=paper_key,
        )

    # ---- 进度同步工具 ----

    def _update_progress(self, session: PaperSession, status: PaperStatus, detail: str = "") -> None:
        """更新内存 session + DB 记录的状态和进度"""
        SessionManager.update_status(session.id, status, detail)
        if detail:
            session.progress_detail = detail
        self._sync_db(session)
        # 推送事件到监控总线
        paper_events.emit(session.id, "progress", stage=status.value, detail=detail)

    def _sync_db(self, session: PaperSession, create_if_missing: bool = False) -> None:
        """将 session 状态同步到 PaperRecord"""
        try:
            from models import db, PaperRecord

            record = PaperRecord.query.get(session.id)
            if not record and not create_if_missing:
                return

            if not record:
                record = PaperRecord(
                    id=session.id,
                    user_id=session.user_id,
                    topic=session.topic,
                    status=session.status.value,
                    progress_detail=session.progress_detail,
                    outline_json=json.dumps(session.file_plan, ensure_ascii=False) if session.file_plan else None,
                    error=session.error,
                )
                db.session.add(record)
            else:
                record.status = session.status.value
                record.progress_detail = session.progress_detail
                record.error = session.error
                if session.file_plan:
                    record.outline_json = json.dumps(session.file_plan, ensure_ascii=False)

            db.session.commit()
        except Exception as e:
            print(f"[Paper] _sync_db 失败: {e}")
            try:
                from models import db
                db.session.rollback()
            except Exception:
                pass

    # ---- VFS 快照 ----

    def _save_vfs_snapshot(self, session: PaperSession) -> None:
        """将当前 VFS 快照 + session 元数据上传到 S3，更新 DB 记录的 vfs_s3_key"""
        import gzip
        import json as _json

        vfs_data = session.vfs.get_all()
        if not vfs_data:
            return

        # 把 session 中间产物写入 VFS 的 __meta__ 命名空间，随 VFS 一起持久化
        if session.literature:
            session.vfs.write("__meta__/literature.json", _json.dumps(session.literature, ensure_ascii=False))
        if session.content:
            session.vfs.write("__meta__/content.json", _json.dumps(session.content, ensure_ascii=False))
        if session.design_context:
            session.vfs.write("__meta__/design_context.txt", session.design_context)
        if session.embedding_index and session.embedding_index.chunks:
            session.vfs.write("__meta__/embeddings.json", session.embedding_index.serialize())

        vfs_json = session.vfs.serialize().encode("utf-8")

        # 序列化完成后清理 __meta__ 文件，避免污染编译器
        for f in list(session.vfs.list_files()):
            if f.startswith("__meta__/"):
                session.vfs.delete(f)

        vfs_gz = gzip.compress(vfs_json)
        vfs_key = f"users/{session.user_id}/papers/{session.id}/vfs.json.gz"

        self.storage.upload_bytes(vfs_gz, vfs_key, "application/gzip")
        session.vfs_s3_key = vfs_key

        try:
            from models import db, PaperRecord
            record = PaperRecord.query.get(session.id)
            if record:
                record.vfs_s3_key = vfs_key
                if session.file_plan:
                    record.outline_json = _json.dumps(session.file_plan, ensure_ascii=False)
                db.session.commit()
        except Exception as e:
            print(f"[Paper] _save_vfs_snapshot DB 更新失败: {e}")

    def _build_embedding_index(self, session: PaperSession) -> None:
        """对 VFS 中的 tex 文件构建 embedding 索引"""
        session.progress_detail = "构建语义索引..."
        self._sync_db(session)

        vfs_files = {
            f: session.vfs.read(f)
            for f in session.vfs.list_files()
            if not f.startswith("__meta__/") and session.vfs.read(f)
        }
        count = session.embedding_index.index_vfs(vfs_files)
        print(f"[Paper] Embedding 索引: {count} chunks")

    # ---- 后台生成 ----

    def start_generate(self, user_id: str, topic: str, design_context: str = "", paper_id: str = None) -> str:
        """
        创建 session + DB 记录，启动后台线程执行生成。
        如果传入 paper_id，复用已有的 DB 记录（从规划阶段过来）。
        返回 paper_id，前端轮询 /status 获取进度。
        """
        session = SessionManager.create(user_id, topic)
        session.design_context = design_context

        from models import db, PaperRecord

        if paper_id:
            # 复用已有记录（规划阶段创建的）
            record = PaperRecord.query.get(paper_id)
            if record:
                session.id = paper_id
                SessionManager._sessions[paper_id] = SessionManager._sessions.pop(session.id, session)
                record.status = PaperStatus.PENDING.value
                record.progress_detail = "排队中..."
                record.topic = topic
                db.session.commit()
            else:
                # paper_id 无效，走新建逻辑
                paper_id = None

        if not paper_id:
            record = PaperRecord(
                id=session.id,
                user_id=user_id,
                topic=topic,
                status=PaperStatus.PENDING.value,
                progress_detail="排队中...",
            )
            db.session.add(record)
            db.session.commit()

        # 后台线程
        t = threading.Thread(
            target=self._run_generate,
            args=(session.id,),
            daemon=True,
        )
        t.start()
        return session.id

    def _run_generate(self, session_id: str) -> None:
        """后台线程：执行完整的论文生成流程"""
        with self.app.app_context():
            session = SessionManager.get(session_id)
            if not session:
                return

            # 4 Agent pipeline
            agents_pipeline = [
                (PaperStatus.RESEARCHING, self.researcher),
                (PaperStatus.PLANNING, self.planner),
                (PaperStatus.WRITING, self.writer),
                (PaperStatus.FORMATTING, self.formatter),
            ]

            # 设置 paper_id 以便 agent 推送事件
            for _, agent in agents_pipeline:
                agent._current_paper_id = session.id

            for status, agent in agents_pipeline:
                self._update_progress(session, status, f"{status.value} 阶段开始...")
                paper_events.emit(session.id, "agent_start", agent=type(agent).__name__, stage=status.value)

                passed = False
                max_gate_retries = 2  # gate 不通过时最多重试 2 次

                for gate_attempt in range(1 + max_gate_retries):
                    try:
                        for event in agent.run(session):
                            if event.get("type") == "progress":
                                detail = event.get("detail", "")
                                if detail:
                                    session.progress_detail = detail
                                    self._sync_db(session)
                            # 把 agent 的所有事件都推送到监控
                            paper_events.emit(session.id, "agent_event", agent=type(agent).__name__, event=event)
                    except Exception as e:
                        session.error = f"{status.value} 阶段失败: {e}"
                        self._update_progress(session, PaperStatus.FAILED, session.error)
                        paper_events.emit(session.id, "error", agent=type(agent).__name__, error=str(e))
                        self._save_vfs_snapshot(session)
                        return

                    # Gate 检查
                    gate = agent.gate_check(session)
                    paper_events.emit(session.id, "gate_check", agent=type(agent).__name__, ok=gate.ok, retry=gate.retry, reason=gate.reason)
                    if gate.ok:
                        passed = True
                        break

                    print(f"[Gate] {status.value} 未通过: {gate.reason} (retry={gate.retry})")

                    if not gate.retry:
                        # 需要人工介入
                        session.error = f"{status.value} 阶段质量检查未通过（需要人工介入）: {gate.reason}"
                        self._update_progress(session, PaperStatus.FAILED, session.error)
                        self._save_vfs_snapshot(session)
                        return

                    if gate_attempt < max_gate_retries:
                        session.progress_detail = f"质量检查未通过，正在重试（{gate_attempt + 2}/{1 + max_gate_retries}）: {gate.reason}"
                        self._sync_db(session)

                if not passed:
                    session.error = f"{status.value} 阶段多次重试后仍未通过质量检查"
                    self._update_progress(session, PaperStatus.FAILED, session.error)
                    self._save_vfs_snapshot(session)
                    return

                # planning 完成后确保 DB 记录存在
                if status == PaperStatus.PLANNING:
                    self._sync_db(session, create_if_missing=True)

                # 每个阶段完成后保存 VFS 快照，防止中途失败丢数据
                self._save_vfs_snapshot(session)

            # Formatting 完成后，构建 embedding 索引
            self._build_embedding_index(session)

            # 编译 PDF
            self._compile_with_repair(session)

    def _compile_with_repair(self, session: PaperSession, max_repair: int = 3) -> None:
        """编译 PDF，失败时自动修复重试，最终持久化"""
        from .persist import persist_session
        from models import db

        self._update_progress(session, PaperStatus.COMPILING, "正在编译 PDF...")

        result = None
        for attempt in range(1 + max_repair):
            try:
                result = self.compiler.compile(session.vfs.get_all(), "main.tex")
                paper_events.emit(session.id, "compile", attempt=attempt + 1, success=result.success, error=result.error if not result.success else None, log=(result.log or "")[-2000:])
            except Exception as e:
                session.error = f"编译异常: {e}"
                self._update_progress(session, PaperStatus.FAILED, session.error)
                paper_events.emit(session.id, "error", stage="compiling", error=str(e))
                return

            if result.success:
                break

            remaining = max_repair - attempt
            if remaining <= 0:
                break

            detail = f"编译失败，正在自动修复（第 {attempt + 1}/{max_repair} 轮）..."
            session.progress_detail = detail
            self._sync_db(session)

            for repair_event in self.formatter.repair(session, result.errors or result.log):
                if repair_event.get("type") == "progress":
                    session.progress_detail = repair_event.get("detail", "")
                    self._sync_db(session)

            session.progress_detail = "重新编译中..."
            self._sync_db(session)

        if not result or not result.success:
            session.error = f"编译失败（已尝试 {max_repair} 轮修复）: {result.error if result else 'unknown'}"
            self._update_progress(session, PaperStatus.FAILED, session.error)
            self._save_vfs_snapshot(session)
            return

        # 持久化
        session.progress_detail = "正在保存..."
        self._sync_db(session)
        session.pdf_data = result.pdf_data
        SessionManager.update_status(session.id, PaperStatus.COMPLETED)
        persist_session(session, self.storage, db, upsert=True)

        # 确保 DB status 是 completed（防止 persist_session 内部状态不一致）
        try:
            from models import PaperRecord as PR
            rec = PR.query.get(session.id)
            if rec and rec.status != PaperStatus.COMPLETED.value:
                rec.status = PaperStatus.COMPLETED.value
                rec.error = None
                db.session.commit()
        except Exception:
            pass

        print(f"[Paper] 论文生成完成: {session.id}")
        paper_events.emit(session.id, "completed", pdf_url=session.pdf_url)


    # ---- 后台重试（LLM 智能诊断修复） ----

    # pipeline 阶段顺序（前端 ProgressView 使用）
    _PIPELINE_ORDER = ["researching", "planning", "writing", "formatting", "compiling"]

    def start_retry(self, paper_id: str) -> bool:
        """
        智能重试：从 S3 恢复 VFS，让 reviewer LLM 诊断错误并自主修复。
        本质上就是 _run_revise，只是 instruction 由系统自动生成（错误诊断）。
        返回 True 表示成功启动，False 表示论文不存在。
        """
        from .persist import restore_session
        from models import db, PaperRecord

        record = PaperRecord.query.get(paper_id)
        if not record:
            return False

        session = restore_session(paper_id, self.storage, db)
        if not session:
            return False

        # 恢复 design_context（从 planning_messages 重建）
        if record.planning_messages and not session.design_context:
            import json as _json
            messages = _json.loads(record.planning_messages)
            session.design_context = "\n".join(
                f"{'用户' if m['role'] == 'user' else 'AI'}: {m['content']}"
                for m in messages if m.get("content")
            )

        # 构建诊断指令，交给 reviewer LLM 自主修复
        diagnosis = self._build_retry_diagnosis(session, record.error)

        SessionManager._sessions[session.id] = session
        record.status = PaperStatus.PENDING.value
        record.progress_detail = "正在诊断错误..."
        record.error = None
        db.session.commit()

        t = threading.Thread(
            target=self._run_revise,
            args=(session.id, diagnosis),
            daemon=True,
        )
        t.start()
        return True

    def _build_retry_diagnosis(self, session: PaperSession, error: str | None) -> str:
        """构建自动诊断指令，描述错误 + VFS 当前状态，作为 reviewer 的输入"""
        parts = ["【自动重试诊断】上次生成失败，请分析并修复问题。\n"]

        if error:
            parts.append(f"错误信息：{error}\n")

        # VFS 文件状态
        files = [f for f in session.vfs.list_files() if not f.startswith("__meta__/")]
        if files:
            parts.append("当前 VFS 文件状态：")
            for f in sorted(files):
                content = session.vfs.read(f) or ""
                size = len(content)
                preview = content[:100].replace("\n", " ").strip()
                parts.append(f"  - {f} ({size} 字符): {preview}...")
        else:
            parts.append("VFS 中没有任何文件。")

        # main.tex 有效性
        main_content = session.vfs.read("main.tex") or ""
        if main_content:
            if "\\documentclass" not in main_content or "\\begin{document}" not in main_content:
                parts.append("\n⚠ main.tex 不是有效的文档框架（缺少 \\documentclass 或 \\begin{document}），需要用 regenerate_main_tex 重建。")
        else:
            parts.append("\n⚠ main.tex 不存在，需要用 regenerate_main_tex 生成。")

        # refs.bib 有效性
        bib_content = session.vfs.read("refs.bib") or ""
        if not bib_content.strip():
            parts.append("⚠ refs.bib 为空，需要用 regenerate_refs_bib 重建。")

        parts.append("\n请诊断问题根因，用最轻量的方式修复。")

        return "\n".join(parts)

    # ---- 后台修订 ----

    def start_revise(self, paper_id: str, instruction: str) -> bool:
        """
        启动后台线程执行论文修订。
        返回 True 表示成功启动，False 表示论文不存在。
        """
        from .persist import restore_session
        from models import db

        session = restore_session(paper_id, self.storage, db)
        if not session:
            return False

        SessionManager._sessions[session.id] = session
        self._update_progress(session, PaperStatus.FORMATTING, "正在分析修改需求...")

        t = threading.Thread(
            target=self._run_revise,
            args=(session.id, instruction),
            daemon=True,
        )
        t.start()
        return True

    # 修订工具定义：在基础文件操作之上增加高级操作 + 确定性重建工具
    _REVISE_TOOLS = [
        {
            "type": "function",
            "function": {
                "name": "search_chunks",
                "description": "语义检索：输入查询文本，返回论文中最相关的代码块（精确到 section 级，含文件路径和行号）。可多次调用、换关键词缩小范围。优先用此工具定位需要修改的位置",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "检索关键词，如章节标题、概念名称、要修改的内容描述等"},
                        "top_k": {"type": "integer", "description": "返回数量，默认 5", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "列出论文所有文件路径",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取指定文件的完整内容。当 search_chunks 定位到文件后，用此工具获取完整上下文",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径，如 main.tex、chapters/01_intro.tex、refs.bib"}
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "将修改后的内容写入指定文件（覆盖）。适用于小范围修改：改措辞、修错误、调格式、换文献条目等",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                        "content": {"type": "string", "description": "修改后的完整文件内容"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "regenerate_main_tex",
                "description": "确定性重建 main.tex：根据论文规划元数据（标题、章节列表、摘要、引用格式等）重新生成 main.tex 文档框架。不调用 LLM，纯模板生成。当 main.tex 损坏、缺失或内容不是文档框架时使用",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "regenerate_refs_bib",
                "description": "确定性重建 refs.bib：根据 session 中的文献数据重新生成 BibTeX 文件。不调用 LLM，纯数据转换。当 refs.bib 为空或损坏时使用",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "rewrite_chapter",
                "description": "重写某个章节（纯文本撰写 + LaTeX 排版）。适用于需要大幅重写某章内容但不改变整体结构的情况。会调用 AI 写手重新撰写该章节",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "章节文件路径，如 chapters/03_method.tex",
                        },
                        "requirements": {
                            "type": "string",
                            "description": "重写要求：要改什么、怎么改、新的侧重点等",
                        },
                    },
                    "required": ["file_path", "requirements"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "replan_and_rewrite",
                "description": "重新规划论文结构并重写所有章节。仅在需要大幅调整论文框架（增删章节、改变整体方向）时使用。这是最重的操作，会从结构规划阶段重新开始",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "为什么需要重新规划（会作为新的规划要求传递给规划师）",
                        },
                    },
                    "required": ["reason"],
                },
            },
        },
    ]

    _REVISE_SYSTEM_PROMPT = (
        "你是学术论文修订专家。用户会给你一条修改指令（可能是人工指令，也可能是自动诊断的错误信息）。\n\n"
        "可用工具（从轻到重）：\n"
        "0. search_chunks: 语义检索论文代码块。输入关键词返回最相关的 section 级代码段（含文件路径和行号）。先用此工具定位需要修改的位置\n"
        "1. read_file + write_file: 直接编辑文件。适用于大部分修改：改措辞、修错误、调格式、换文献、增删段落等\n"
        "2. regenerate_main_tex: 确定性重建 main.tex（不调用 LLM）。当 main.tex 损坏或不是有效文档框架时使用\n"
        "3. regenerate_refs_bib: 确定性重建 refs.bib（不调用 LLM）。当 refs.bib 为空或损坏时使用\n"
        "4. rewrite_chapter: 重写某个章节。适用于需要大幅重写某章但不改结构的情况\n"
        "5. replan_and_rewrite: 重新规划+重写全部。仅在需要改变论文整体框架时使用\n\n"
        "流程：\n"
        "1. 先用 search_chunks 检索与修改指令相关的代码块，可多次检索、换关键词\n"
        "2. 根据检索结果判断修改范围，如需完整上下文用 read_file\n"
        "3. 用最轻量的方式完成修改\n\n"
        "原则：\n"
        "- 优先用最轻量的方式完成修改，避免不必要的重写\n"
        "- main.tex 损坏 → regenerate_main_tex（一步到位，不要手动拼）\n"
        "- refs.bib 为空或损坏 → regenerate_refs_bib（一步到位）\n"
        "- 换一个文献 → 直接 write_file 改 refs.bib + 相关章节的 \\cite\n"
        "- 某章节论述方向要大改 → rewrite_chapter\n"
        "- 整体结构要调整 → replan_and_rewrite\n"
        "- 绝对不使用 itemize/enumerate/item 结构\n"
        "- 修改完成后，回复一句简短总结说明改了什么"
    )

    def _run_revise(self, session_id: str, instruction: str) -> None:
        """后台线程：用 embedding 检索工具 + function calling 执行灵活修订"""
        with self.app.app_context():
            session = SessionManager.get(session_id)
            if not session:
                return

            self._update_progress(session, PaperStatus.FORMATTING, "正在按要求修改...")

            # 设置 paper_id 以便推送事件
            self.formatter._current_paper_id = session.id
            self.writer._current_paper_id = session.id

            vfs = session.vfs
            modified_files: list[str] = []
            needs_full_rerun: str | None = None

            # 如果没有 embedding 索引，尝试重建
            if not session.embedding_index or not session.embedding_index.chunks:
                self._build_embedding_index(session)

            idx = session.embedding_index
            all_files = [f for f in vfs.list_files() if not f.startswith("__meta__/")]
            file_list = "所有文件: " + ", ".join(all_files)

            def tool_handler(name: str, arguments: dict) -> str:
                nonlocal needs_full_rerun

                if name == "search_chunks":
                    query = arguments.get("query", "")
                    top_k = arguments.get("top_k", 5)
                    if not query:
                        return "错误: query 不能为空"
                    if idx and idx.chunks:
                        results = idx.search(query, top_k=top_k)
                    else:
                        return "（无语义索引，请用 list_files + read_file 直接读取文件）"
                    if not results:
                        return "未找到相关代码块，请换关键词重试或用 read_file 直接读取"
                    parts = []
                    for chunk in results:
                        parts.append(
                            f"--- {chunk.file_path} (行 {chunk.line_start}-{chunk.line_end}, "
                            f"section: {chunk.section_title}) ---\n{chunk.content}"
                        )
                    return "\n\n".join(parts)

                if name == "list_files":
                    files = [f for f in vfs.list_files() if not f.startswith("__meta__/")]
                    return "\n".join(files) if files else "(空)"

                if name == "read_file":
                    path = arguments.get("path", "")
                    content = vfs.read(path)
                    return content if content is not None else f"错误: 文件 {path} 不存在"

                if name == "write_file":
                    path = arguments.get("path", "")
                    content = arguments.get("content", "")
                    vfs.write(path, content)
                    modified_files.append(path)
                    session.progress_detail = f"已修改 {path}"
                    self._sync_db(session)
                    return f"已写入 {path}（{len(content)} 字符）"

                if name == "regenerate_main_tex":
                    if not session.file_plan:
                        return "错误: 没有论文规划数据，无法重建 main.tex"
                    new_main = self.formatter._generate_main(session.file_plan, session)
                    vfs.write("main.tex", new_main)
                    modified_files.append("main.tex")
                    session.progress_detail = "已重建 main.tex"
                    self._sync_db(session)
                    return f"已重建 main.tex（{len(new_main)} 字符）"

                if name == "regenerate_refs_bib":
                    if not session.literature:
                        return "错误: 没有文献数据，无法重建 refs.bib"
                    new_bib = self.formatter._generate_bib(session.literature)
                    vfs.write("refs.bib", new_bib)
                    modified_files.append("refs.bib")
                    session.progress_detail = "已重建 refs.bib"
                    self._sync_db(session)
                    return f"已重建 refs.bib（{len(new_bib)} 字符，{len(session.literature)} 条文献）"

                if name == "rewrite_chapter":
                    file_path = arguments.get("file_path", "")
                    requirements = arguments.get("requirements", "")
                    return self._revise_rewrite_chapter(session, file_path, requirements, modified_files)

                if name == "replan_and_rewrite":
                    reason = arguments.get("reason", "")
                    needs_full_rerun = "planning"
                    session.design_context = (
                        (session.design_context or "")
                        + f"\n\n【修订要求】{reason}"
                    )
                    return "已标记需要重新规划，将在当前对话结束后从 planning 阶段重新开始"

                return f"未知工具: {name}"

            messages = [
                {"role": "system", "content": self._REVISE_SYSTEM_PROMPT},
                {"role": "user", "content": (
                    f"{file_list}\n\n"
                    f"请按以下要求修改论文：\n\n{instruction}"
                )},
            ]

            self.formatter._complete_with_tools(
                messages,
                tools=self._REVISE_TOOLS,
                tool_handler=tool_handler,
                max_rounds=15,
            )

            # 如果 LLM 决定需要重跑 pipeline
            if needs_full_rerun:
                print(f"[Paper] 修订触发 pipeline 重跑: from {needs_full_rerun}")
                self._run_generate(session_id)
                return

            if not modified_files:
                session.error = "未能执行修改，请尝试更具体的指令"
                self._update_progress(session, PaperStatus.FAILED, session.error)
                return

            # 修改后重建 embedding 索引
            self._build_embedding_index(session)

            # 重新编译
            self._compile_with_repair(session)

    def _revise_rewrite_chapter(
        self, session: PaperSession, file_path: str, requirements: str, modified_files: list[str]
    ) -> str:
        """重写单个章节：writer 直接输出 LaTeX，strip code fences 后写入 VFS"""
        outline = session.file_plan.get("outline", {})
        chapter_plan = outline.get(file_path)
        if not chapter_plan:
            return f"错误: {file_path} 不在论文规划中"

        session.progress_detail = f"重写章节: {chapter_plan.get('title', file_path)}..."
        self._sync_db(session)

        # 构建该章节的引用信息
        citations_info = ""
        for ref_id in chapter_plan.get("citations", []):
            idx = int(ref_id.replace("ref", "")) - 1
            if 0 <= idx < len(session.literature):
                lit = session.literature[idx]
                citations_info += f"- [{ref_id}] {lit.get('title', '')} ({lit.get('year', '')})\n"

        global_req = session.file_plan.get("global_requirements", "")
        chapter_req = chapter_plan.get("requirements", "")
        title = chapter_plan.get('title', '')
        sections = chapter_plan.get('sections', [])

        # Writer 直接输出 LaTeX
        write_prompt = f"""重写学术论文章节，直接输出 LaTeX 格式：

论文主题: {session.topic}
章节标题: {title}
子节: {', '.join(sections)}
要点: {', '.join(chapter_plan.get('key_points', []))}
目标字数: {chapter_plan.get('target_words', 800)}

可引用文献:
{citations_info}

修改要求: {requirements}
{f'全局写作要求: {global_req}' if global_req else ''}
{f'章节特定要求: {chapter_req}' if chapter_req else ''}

要求：
1. 用 \\section{{{title}}} 开头
2. 子节用 \\subsection{{}} 标记
3. 引用格式用 \\cite{{refN}}，如 \\cite{{ref1}}
4. 数学内容用 $...$ 或 \\[...\\]
5. 特殊字符必须转义（% → \\%，& → \\&，_ → \\_，# → \\#）
6. 绝对不使用 itemize/enumerate/item，用段落自然组织
7. 学术写作风格，严谨客观
8. 按修改要求重写，但保持学术论文的连贯性
9. 不要输出 \\documentclass、\\begin{{document}} 等文档框架
10. 不要输出 ```latex 等代码块标记"""

        new_content = self.writer._complete([{"role": "user", "content": write_prompt}])
        if not new_content:
            return f"错误: 重写 {file_path} 失败"

        # 更新 session.content（现在存的就是 LaTeX）
        session.content[file_path] = new_content

        # strip code fences 后写入 VFS
        latex_content = self.formatter._strip_code_fences(new_content)
        session.vfs.write(file_path, latex_content)
        modified_files.append(file_path)

        session.progress_detail = f"已重写 {file_path}"
        self._sync_db(session)
        return f"已重写 {file_path}（{len(latex_content)} 字符）"
