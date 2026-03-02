"""
Embedding 索引 — 对 VFS 中的 tex 文件按 section 切 chunk，做 embedding，
支持语义检索（编译错误定位、修订指令匹配）。

纯内存，不需要向量数据库。论文级别的数据量（<100 chunks）用暴力 cosine 就够。
"""

import os
import re
import math
import json
import httpx


class Chunk:
    """一个文本块：来自某个文件的某段内容"""
    __slots__ = ("file_path", "section_title", "content", "line_start", "line_end", "embedding")

    def __init__(self, file_path: str, section_title: str, content: str,
                 line_start: int, line_end: int):
        self.file_path = file_path
        self.section_title = section_title
        self.content = content
        self.line_start = line_start
        self.line_end = line_end
        self.embedding: list[float] | None = None

    def location(self) -> str:
        return f"{self.file_path}:{self.line_start}-{self.line_end}"

    def to_dict(self) -> dict:
        return {
            "file_path": self.file_path,
            "section_title": self.section_title,
            "content": self.content,
            "line_start": self.line_start,
            "line_end": self.line_end,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Chunk":
        return cls(
            file_path=d["file_path"],
            section_title=d["section_title"],
            content=d["content"],
            line_start=d["line_start"],
            line_end=d["line_end"],
        )


class EmbeddingIndex:
    """内存向量索引：chunk 列表 + embedding 向量"""

    def __init__(self):
        self.chunks: list[Chunk] = []
        self._model = os.environ.get("MODEL_EMBEDDING", "text-embedding-v3")
        self._api_key = os.environ.get("QWEN_API_KEY", "")
        self._base_url = os.environ.get(
            "EMBEDDING_API_BASE_URL",
            os.environ.get("QWEN_API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )

    # ---- 切分 ----

    def index_vfs(self, vfs_files: dict[str, str]) -> int:
        """
        对 VFS 中的 tex 文件按 section 切 chunk 并做 embedding。
        返回 chunk 数量。
        """
        self.chunks.clear()

        for file_path, content in vfs_files.items():
            if not file_path.endswith(".tex"):
                continue
            if file_path == "main.tex":
                # main.tex 整体作为一个 chunk
                self.chunks.append(Chunk(file_path, "main", content, 1, content.count("\n") + 1))
                continue

            chunks = self._split_by_section(file_path, content)
            self.chunks.extend(chunks)

        if not self.chunks:
            return 0

        # 批量做 embedding
        texts = [c.content[:2000] for c in self.chunks]  # 截断防超长
        embeddings = self._embed_batch(texts)
        if embeddings and len(embeddings) == len(self.chunks):
            for chunk, emb in zip(self.chunks, embeddings):
                chunk.embedding = emb

        return len(self.chunks)

    def _split_by_section(self, file_path: str, content: str) -> list[Chunk]:
        """按 \\section / \\subsection 切分 tex 文件"""
        lines = content.split("\n")
        chunks: list[Chunk] = []
        current_title = file_path
        current_lines: list[str] = []
        current_start = 1

        section_re = re.compile(r"^\\(sub)?section\{(.+?)\}")

        for i, line in enumerate(lines):
            m = section_re.match(line.strip())
            if m and current_lines:
                # 保存前一个 chunk
                text = "\n".join(current_lines)
                if text.strip():
                    chunks.append(Chunk(
                        file_path, current_title, text,
                        current_start, current_start + len(current_lines) - 1,
                    ))
                current_title = m.group(2)
                current_lines = [line]
                current_start = i + 1
            else:
                if m:
                    current_title = m.group(2)
                current_lines.append(line)

        # 最后一个 chunk
        if current_lines:
            text = "\n".join(current_lines)
            if text.strip():
                chunks.append(Chunk(
                    file_path, current_title, text,
                    current_start, current_start + len(current_lines) - 1,
                ))

        return chunks

    # ---- 检索 ----

    def search(self, query: str, top_k: int = 3) -> list[Chunk]:
        """语义检索：query embedding → cosine similarity → top-K chunks"""
        if not self.chunks:
            return []

        # 检查是否有 embedding（可能 API 调用失败了）
        has_embeddings = any(c.embedding is not None for c in self.chunks)
        if not has_embeddings:
            # fallback：关键词匹配
            return self._keyword_search(query, top_k)

        query_emb = self._embed_single(query)
        if not query_emb:
            return self._keyword_search(query, top_k)

        scored = []
        for chunk in self.chunks:
            if chunk.embedding is None:
                continue
            sim = self._cosine_similarity(query_emb, chunk.embedding)
            scored.append((sim, chunk))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]

    def search_by_error(self, error_log: str, top_k: int = 5) -> list[Chunk]:
        """
        编译错误定位：从错误日志中提取文件名和行号，
        优先精确匹配，再用语义检索补充。
        """
        results: list[Chunk] = []
        seen_locations: set[str] = set()

        # 1. 精确匹配：从错误日志提取文件名和行号
        file_line_re = re.compile(r"\./([\w/]+\.tex):?(\d+)?")
        line_num_re = re.compile(r"^l\.(\d+)", re.MULTILINE)

        mentioned_files: set[str] = set()
        mentioned_lines: dict[str, list[int]] = {}

        for m in file_line_re.finditer(error_log):
            fpath = m.group(1)
            mentioned_files.add(fpath)
            if m.group(2):
                mentioned_lines.setdefault(fpath, []).append(int(m.group(2)))

        for m in line_num_re.finditer(error_log):
            line_no = int(m.group(1))
            # 行号没有文件名，尝试匹配最近提到的文件
            for fpath in mentioned_files:
                mentioned_lines.setdefault(fpath, []).append(line_no)

        # 找包含这些行号的 chunk
        for chunk in self.chunks:
            if chunk.file_path in mentioned_files:
                lines_in_file = mentioned_lines.get(chunk.file_path, [])
                if not lines_in_file or any(
                    chunk.line_start <= ln <= chunk.line_end for ln in lines_in_file
                ):
                    loc = chunk.location()
                    if loc not in seen_locations:
                        results.append(chunk)
                        seen_locations.add(loc)

        # 2. 语义检索补充
        if len(results) < top_k:
            semantic = self.search(error_log[:500], top_k=top_k)
            for chunk in semantic:
                loc = chunk.location()
                if loc not in seen_locations:
                    results.append(chunk)
                    seen_locations.add(loc)
                    if len(results) >= top_k:
                        break

        return results[:top_k]

    def get_file_chunks(self, file_path: str) -> list[Chunk]:
        """获取某个文件的所有 chunk"""
        return [c for c in self.chunks if c.file_path == file_path]

    def _keyword_search(self, query: str, top_k: int) -> list[Chunk]:
        """fallback：简单关键词匹配"""
        query_lower = query.lower()
        keywords = [w for w in re.split(r"\W+", query_lower) if len(w) > 1]
        if not keywords:
            return self.chunks[:top_k]

        scored = []
        for chunk in self.chunks:
            content_lower = chunk.content.lower()
            score = sum(1 for kw in keywords if kw in content_lower)
            if score > 0:
                scored.append((score, chunk))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]

    # ---- Embedding API ----

    def _embed_batch(self, texts: list[str]) -> list[list[float]] | None:
        """批量 embedding（DashScope 兼容 OpenAI 格式）"""
        if not texts or not self._api_key:
            print("[Embedding] 跳过：无文本或无 API key")
            return None

        endpoint = f"{self._base_url.rstrip('/')}/embeddings"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        # DashScope 单次最多 25 条，分批
        all_embeddings: list[list[float]] = []
        batch_size = 20

        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            payload = {
                "model": self._model,
                "input": batch,
            }

            print(f"[Embedding] 批次 {i // batch_size + 1}: {len(batch)} 条文本")

            try:
                with httpx.Client(timeout=60.0) as client:
                    resp = client.post(endpoint, headers=headers, json=payload)

                if resp.status_code != 200:
                    print(f"[Embedding] 错误: HTTP {resp.status_code} - {resp.text[:300]}")
                    return None

                data = resp.json()
                batch_embs = [item["embedding"] for item in data.get("data", [])]
                all_embeddings.extend(batch_embs)

            except Exception as e:
                print(f"[Embedding] 异常: {type(e).__name__}: {e}")
                return None

        return all_embeddings if len(all_embeddings) == len(texts) else None

    def _embed_single(self, text: str) -> list[float] | None:
        """单条 embedding"""
        result = self._embed_batch([text[:2000]])
        return result[0] if result else None

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        """纯 Python cosine similarity，不依赖 numpy"""
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    # ---- 序列化（持久化到 VFS __meta__）----

    def serialize(self) -> str:
        """序列化 chunk 列表 + embedding 为 JSON"""
        data = []
        for c in self.chunks:
            d = c.to_dict()
            d["embedding"] = c.embedding
            data.append(d)
        return json.dumps(data, ensure_ascii=False)

    @classmethod
    def deserialize(cls, raw: str) -> "EmbeddingIndex":
        """从 JSON 反序列化"""
        idx = cls()
        data = json.loads(raw)
        for d in data:
            emb = d.pop("embedding", None)
            chunk = Chunk.from_dict(d)
            chunk.embedding = emb
            idx.chunks.append(chunk)
        return idx
