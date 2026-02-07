"""
PaperService — 论文生成主服务
串联 4 Agent pipeline → 编译 PDF → 输出 SSE 事件流
"""

import os
import json
from typing import Generator

from .agents import ResearcherAgent, PlannerAgent, WriterAgent, FormatterAgent
from .latex import get_compiler
from .session import PaperSession, PaperStatus, SessionManager


class PaperService:
    """论文生成主服务：协调 Agent pipeline + LaTeX 编译"""

    def __init__(self, llm_service, storage_service):
        self.storage = storage_service
        self.compiler = get_compiler()
        # Paper 专用 API Key，留空则走 LLMService 默认 key 池
        paper_key = os.environ.get("API_KEY_PAPER") or None
        # 每个 Agent 独立配置模型，留空则 fallback 到 MODEL_PRIMARY
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

    def _sync_tracking_record(self, session: PaperSession, create_if_missing: bool = False) -> None:
        """
        将 session 的阶段状态同步到 PaperRecord。
        设计目标：planning 完成后开始持久化，后续阶段持续更新状态，支持刷新后跟踪。
        """
        db = None
        try:
            from models import db as model_db, PaperRecord

            db = model_db
            record = PaperRecord.query.get(session.id)
            if not record and not create_if_missing:
                return

            if not record:
                record = PaperRecord(
                    id=session.id,
                    user_id=session.user_id,
                    topic=session.topic,
                    status=session.status.value,
                    outline_json=json.dumps(session.file_plan, ensure_ascii=False) if session.file_plan else None,
                    error=session.error,
                )
                db.session.add(record)
            else:
                record.topic = session.topic
                record.status = session.status.value
                if session.file_plan:
                    record.outline_json = json.dumps(session.file_plan, ensure_ascii=False)
                record.error = session.error
                if session.status != PaperStatus.COMPLETED:
                    record.completed_at = None

            db.session.commit()
        except Exception as e:
            if db is not None:
                try:
                    db.session.rollback()
                except Exception:
                    pass
            print(f"[Paper] 同步追踪记录失败: {e}")

    @staticmethod
    def _set_progress_detail(session: PaperSession, detail: str) -> None:
        """将最近一条进度详情写入 session，供 /status 轮询读取。"""
        if detail:
            session.progress_detail = detail

    def generate(self, user_id: str, topic: str) -> Generator[dict, None, None]:
        """
        生成论文的完整流程（Generator，逐步 yield SSE 事件）。

        事件类型:
        - session_created: 会话已创建
        - progress: 各阶段进度
        - completed: 生成完成
        - error: 出错
        """
        session = SessionManager.create(user_id, topic)
        yield {"type": "session_created", "session_id": session.id}

        # 4 Agent pipeline
        agents_pipeline = [
            (PaperStatus.RESEARCHING, self.researcher),
            (PaperStatus.PLANNING, self.planner),
            (PaperStatus.WRITING, self.writer),
            (PaperStatus.FORMATTING, self.formatter),
        ]

        for status, agent in agents_pipeline:
            SessionManager.update_status(session.id, status)
            # planning 完成后才创建持久化记录；后续阶段更新同一条记录。
            self._sync_tracking_record(session, create_if_missing=False)
            try:
                for event in agent.run(session):
                    if event["type"] == "progress":
                        self._set_progress_detail(session, event.get("detail", ""))
                        yield event
            except Exception as e:
                session.error = f"{status.value} 阶段失败: {e}"
                SessionManager.update_status(session.id, PaperStatus.FAILED)
                self._sync_tracking_record(session, create_if_missing=False)
                yield {"type": "error", "message": session.error, "session_id": session.id}
                return

            if status == PaperStatus.PLANNING:
                self._sync_tracking_record(session, create_if_missing=True)

        # 编译 PDF（带自动修复，最多重试 MAX_REPAIR_ROUNDS 轮）
        MAX_REPAIR_ROUNDS = 3
        SessionManager.update_status(session.id, PaperStatus.COMPILING)
        self._sync_tracking_record(session, create_if_missing=False)
        detail = "正在编译 PDF..."
        self._set_progress_detail(session, detail)
        yield {"type": "progress", "stage": "compiling", "detail": detail}

        result = None
        for attempt in range(1 + MAX_REPAIR_ROUNDS):
            try:
                result = self.compiler.compile(session.vfs.get_all(), "main.tex")
            except Exception as e:
                session.error = f"编译异常: {e}"
                SessionManager.update_status(session.id, PaperStatus.FAILED)
                self._sync_tracking_record(session, create_if_missing=False)
                yield {"type": "error", "message": session.error, "session_id": session.id}
                return

            if result.success:
                break

            # 还有修复机会 → 让 FormatterAgent 根据错误日志修复
            remaining = MAX_REPAIR_ROUNDS - attempt
            if remaining <= 0:
                break

            detail = f"编译失败，正在自动修复（第 {attempt}/{MAX_REPAIR_ROUNDS} 轮）..."
            self._set_progress_detail(session, detail)
            yield {"type": "progress", "stage": "compiling", "detail": detail}
            for repair_event in self.formatter.repair(session, result.errors or result.log):
                if repair_event.get("type") == "progress":
                    self._set_progress_detail(session, repair_event.get("detail", ""))
                yield repair_event

            detail = "重新编译中..."
            self._set_progress_detail(session, detail)
            yield {"type": "progress", "stage": "compiling", "detail": detail}

        if not result or not result.success:
            session.error = f"编译失败（已尝试 {MAX_REPAIR_ROUNDS} 轮修复）: {result.error if result else 'unknown'}"
            SessionManager.update_status(session.id, PaperStatus.FAILED)
            self._sync_tracking_record(session, create_if_missing=False)
            yield {"type": "error", "message": session.error, "session_id": session.id}
            return

        # 持久化：上传 PDF + VFS 快照 + 写 PaperRecord
        detail = "正在保存..."
        self._set_progress_detail(session, detail)
        yield {"type": "progress", "stage": "compiling", "detail": detail}
        session.pdf_data = result.pdf_data
        SessionManager.update_status(session.id, PaperStatus.COMPLETED)

        from .persist import persist_session
        from models import db
        persist_session(session, self.storage, db, upsert=True)
        yield {"type": "completed", "pdf_url": session.pdf_url, "session_id": session.id}

    def revise(self, paper_id: str, instruction: str) -> Generator[dict, None, None]:
        """
        修订已有论文：从 S3 恢复 VFS → LLM 按用户指令修改 → 重新编译 → 重新持久化。

        事件类型同 generate()。
        """
        from .persist import restore_session, persist_session
        from models import db, PaperRecord

        detail = "正在恢复论文数据..."
        yield {"type": "progress", "stage": "revising", "detail": detail}

        session = restore_session(paper_id, self.storage, db)
        if not session:
            yield {"type": "error", "message": "论文不存在或数据已丢失", "session_id": paper_id}
            return

        # 放入内存管理
        SessionManager._sessions[session.id] = session
        SessionManager.update_status(session.id, PaperStatus.FORMATTING)

        detail = "正在按要求修改..."
        self._set_progress_detail(session, detail)
        yield {"type": "progress", "stage": "revising", "detail": detail}

        # 用 FormatterAgent 的 function calling 能力执行用户修改指令
        vfs = session.vfs
        modified_files: list[str] = []

        def tool_handler(name: str, arguments: dict) -> str:
            if name == "list_files":
                files = vfs.list_files()
                return "\n".join(files) if files else "(空)"
            if name == "read_file":
                path = arguments.get("path", "")
                content = vfs.read(path)
                if content is None:
                    return f"错误: 文件 {path} 不存在"
                return content
            if name == "write_file":
                path = arguments.get("path", "")
                content = arguments.get("content", "")
                vfs.write(path, content)
                modified_files.append(path)
                return f"已写入 {path}（{len(content)} 字符）"
            return f"未知工具: {name}"

        messages = [
            {
                "role": "system",
                "content": (
                    "你是学术论文 LaTeX 修订专家。用户会给你一条修改指令，"
                    "你需要通过工具读取相关文件、按指令修改、写回。\n\n"
                    "规则：\n"
                    "1. 先用 list_files 查看论文文件结构\n"
                    "2. 用 read_file 读取需要修改的文件\n"
                    "3. 按用户指令修改内容，保持 LaTeX 语法正确\n"
                    "4. 绝对不使用 itemize/enumerate/item 结构\n"
                    "5. 用 write_file 写回修改后的完整文件内容\n"
                    "6. 修改完成后，回复一句简短总结"
                ),
            },
            {
                "role": "user",
                "content": f"请按以下要求修改论文：\n\n{instruction}",
            },
        ]

        self.formatter._complete_with_tools(
            messages,
            tools=self.formatter.REPAIR_TOOLS,
            tool_handler=tool_handler,
            max_rounds=15,
        )

        for f in modified_files:
            detail = f"已修改 {f}"
            self._set_progress_detail(session, detail)
            yield {"type": "progress", "stage": "revising", "detail": detail}

        if not modified_files:
            yield {"type": "error", "message": "未能执行修改，请尝试更具体的指令", "session_id": session.id}
            return

        # 重新编译
        MAX_REPAIR_ROUNDS = 3
        SessionManager.update_status(session.id, PaperStatus.COMPILING)
        detail = "正在重新编译 PDF..."
        self._set_progress_detail(session, detail)
        yield {"type": "progress", "stage": "compiling", "detail": detail}

        result = None
        for attempt in range(1 + MAX_REPAIR_ROUNDS):
            try:
                result = self.compiler.compile(session.vfs.get_all(), "main.tex")
            except Exception as e:
                session.error = f"编译异常: {e}"
                SessionManager.update_status(session.id, PaperStatus.FAILED)
                yield {"type": "error", "message": session.error, "session_id": session.id}
                return

            if result.success:
                break

            remaining = MAX_REPAIR_ROUNDS - attempt
            if remaining <= 0:
                break

            detail = f"编译失败，正在自动修复（第 {attempt}/{MAX_REPAIR_ROUNDS} 轮）..."
            self._set_progress_detail(session, detail)
            yield {"type": "progress", "stage": "compiling", "detail": detail}
            for repair_event in self.formatter.repair(session, result.errors or result.log):
                if repair_event.get("type") == "progress":
                    self._set_progress_detail(session, repair_event.get("detail", ""))
                yield repair_event
            detail = "重新编译中..."
            self._set_progress_detail(session, detail)
            yield {"type": "progress", "stage": "compiling", "detail": detail}

        if not result or not result.success:
            session.error = f"编译失败（已尝试 {MAX_REPAIR_ROUNDS} 轮修复）: {result.error if result else 'unknown'}"
            SessionManager.update_status(session.id, PaperStatus.FAILED)
            yield {"type": "error", "message": session.error, "session_id": session.id}
            return

        # 重新持久化
        detail = "正在保存..."
        self._set_progress_detail(session, detail)
        yield {"type": "progress", "stage": "compiling", "detail": detail}
        session.pdf_data = result.pdf_data
        SessionManager.update_status(session.id, PaperStatus.COMPLETED)

        # 更新已有记录而非新建
        record = PaperRecord.query.get(session.id)
        if record:
            pdf_key = record.pdf_s3_key or f"users/{session.user_id}/papers/{session.id}/paper.pdf"
            upload_result = self.storage.upload_pdf(session.pdf_data, pdf_key)
            session.pdf_url = upload_result["url"] if upload_result else record.pdf_url

            vfs_json = session.vfs.serialize().encode("utf-8")
            import gzip
            vfs_gz = gzip.compress(vfs_json)
            vfs_key = record.vfs_s3_key or f"users/{session.user_id}/papers/{session.id}/vfs.json.gz"
            self.storage.upload_bytes(vfs_gz, vfs_key, "application/gzip")

            record.status = PaperStatus.COMPLETED.value
            record.pdf_url = session.pdf_url
            import json
            from datetime import datetime
            record.outline_json = json.dumps(session.file_plan, ensure_ascii=False)
            record.completed_at = datetime.utcnow()
            record.error = None
            db.session.commit()
        else:
            persist_session(session, self.storage, db)

        yield {"type": "completed", "pdf_url": session.pdf_url, "session_id": session.id}
