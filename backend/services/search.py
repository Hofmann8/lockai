"""
联网搜索服务

主通道：阿里云 CleverSee（原 IQS）UnifiedSearch —— 纯搜索接口，返回网页结果，由主模型自己读。
模型在 web_search 的参数里自己选引擎、时间范围、站点和要不要正文（见 tool_contracts.SEARCH_ENGINES），
这里负责翻译成 CleverSee 的参数、兜住它不支持的组合，并把结果压成一段简短文字。

备用通道：中转站 Responses API + 内置 web_search（models.json 的 search_builtin）。
没配 CLEVERSEE_API_KEY 或 CleverSee 请求失败时自动改走这里。
"""

from __future__ import annotations

import html
import json
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .http_client import build_http_client
from .prompts import get_search_prompt
from .tool_contracts import SEARCH_ENGINES

MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
# 搜索模型经常在链接后面加上 ?utm_source=openai 之类的追踪参数
TRACKING_PARAM_RE = re.compile(r"[?&]utm_[a-z]+=[^&#\s)]*")
TAG_RE = re.compile(r"<[^>]+>")
# Generic 的天气、汇率等结构化数据只认"杭州天气"这种短查询，带上日期就不返回了（实测）
DATE_IN_QUERY_RE = re.compile(r"\d{4}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?|\d{1,2}月\d{1,2}[日号]|\d{4}-\d{1,2}-\d{1,2}")
SPACE_RE = re.compile(r"\s+")

CLEVERSEE_URL = "https://cloud-iqs.aliyuncs.com/search/unified"

# 模型看到的引擎名 → CleverSee engineType 及各自支持的参数（2026-09 实测）
ENGINES: dict[str, dict[str, Any]] = {
    "cn_fast": {"engineType": "CNLiteBasic", "label": "", "sites": True, "time": True},
    "cn_news": {"engineType": "CNAuto", "label": "新闻", "sites": False, "time": True},
    "cn_authority": {"engineType": "Generic", "label": "权威", "sites": False, "time": False},
    "global": {"engineType": "GlobalAdvanced", "label": "海外", "sites": True, "time": False},
}
assert set(ENGINES) == set(SEARCH_ENGINES)
TIME_RANGES = {"day": "OneDay", "week": "OneWeek", "month": "OneMonth", "year": "OneYear"}

RESULTS_PER_SEARCH = 8
SNIPPET_CHARS = 280
FULL_TEXT_ITEMS = 3
FULL_TEXT_CHARS = 1200
FEW_RESULTS = 3


def normalize_search_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    """把模型给的 web_search 参数收拾成固定形状；不认识的值退回默认。"""
    args = arguments if isinstance(arguments, dict) else {}
    engine = str(args.get("engine") or "cn_fast").strip()
    time_range = str(args.get("time_range") or "any").strip()
    sites = ",".join(s.strip() for s in str(args.get("sites") or "").replace("，", ",").split(",") if s.strip())
    return {
        "query": str(args.get("query") or "").strip(),
        "engine": engine if engine in ENGINES else "cn_fast",
        "time_range": time_range if time_range in TIME_RANGES else "any",
        "sites": sites,
        "full_text": args.get("full_text") is True or str(args.get("full_text")).lower() == "true",
    }


def engine_label(engine: str) -> str:
    return ENGINES.get(engine, {}).get("label", "")


class SearchService:
    """联网搜索服务。"""

    MAX_SOURCES = 8
    FAILED = "搜索失败，请基于已有知识继续回答，并告诉用户没能联网查到最新信息。"

    def __init__(self, llm_service):
        self.llm = llm_service
        self.cleversee_key = os.environ.get("CLEVERSEE_API_KEY", "").strip()
        self.default_city = os.environ.get("CLEVERSEE_DEFAULT_CITY", "杭州市").strip()

    def search(self, query: str) -> str:
        return self.search_with_sources(query)[0]

    def search_with_sources(self, query: str, **options) -> tuple[str, list[dict[str, str]]]:
        """返回 (给主模型看的搜索结果, 给前端展示的来源列表)。失败时结果以"搜索失败"开头。"""
        args = normalize_search_args({"query": query, **options})
        if not args["query"]:
            return self.FAILED, []
        if self.cleversee_key:
            result = self._search_cleversee(args)
            if result is not None:
                return result
            print("[Search] CleverSee 失败，改走中转站搜索")
        return self._search_relay(args["query"])

    # ------------------------------------------------------------------
    # CleverSee
    # ------------------------------------------------------------------

    def _search_cleversee(self, args: dict[str, Any]) -> tuple[str, list[dict[str, str]]] | None:
        notes: list[str] = []
        engine = args["engine"]
        if args["sites"] and not ENGINES[engine]["sites"]:
            notes.append(f"{engine} 不支持限定站点，已改用 cn_fast")
            engine = "cn_fast"
        spec = ENGINES[engine]
        if args["time_range"] != "any" and not spec["time"]:
            notes.append(f"{engine} 不支持时间范围，已忽略；需要的话把年月写进 query")

        body = self._build_body(args, engine)
        data, seconds = self._post(body)
        if data is None:
            return None
        items = data.get("pageItems") or []
        if not items and args["sites"] and spec["sites"]:
            notes.append(f"限定站点 {args['sites']} 没有结果，已放宽为全网")
            body.get("advancedParams", {}).pop("includeSites", None)
            data, extra = self._post(body)
            if data is None:
                return None
            seconds += extra
            items = data.get("pageItems") or []

        scenes = data.get("sceneItems") or []
        print(f"[Search] CleverSee {spec['engineType']} {body['query']!r}: {len(items)} 条, 场景 {[s.get('type') for s in scenes]}, {seconds:.1f}s")
        text = self._format_results(args, engine, items, scenes, notes)
        return text, self._cleversee_sources(items)

    def _build_body(self, args: dict[str, Any], engine: str) -> dict[str, Any]:
        spec = ENGINES[engine]
        query = args["query"]
        if engine == "cn_authority":
            query = SPACE_RE.sub(" ", DATE_IN_QUERY_RE.sub(" ", query)).strip() or query
        body: dict[str, Any] = {"query": query[:500], "engineType": spec["engineType"]}
        advanced: dict[str, str] = {}
        if engine in ("cn_fast", "global"):
            advanced["numResults"] = str(RESULTS_PER_SEARCH)
        if spec["time"] and args["time_range"] != "any":
            body["timeRange"] = TIME_RANGES[args["time_range"]]
        if engine == "cn_authority":
            # 天气、汇率等结构化数据要求 NoLimit；city 只对 Generic 生效，用户没说城市时按默认城市出天气
            body["timeRange"] = "NoLimit"
            if self.default_city:
                body["locationInfo"] = {"city": self.default_city}
        if spec["sites"] and args["sites"]:
            advanced["includeSites"] = args["sites"]
        if args["full_text"]:
            body["contents"] = {"mainText": True}
        if advanced:
            body["advancedParams"] = advanced
        return body

    def _post(self, body: dict[str, Any]) -> tuple[dict[str, Any] | None, float]:
        started = time.monotonic()
        try:
            with build_http_client(httpx.Timeout(connect=5.0, read=9.0, write=5.0, pool=5.0)) as client:
                response = client.post(
                    CLEVERSEE_URL,
                    headers={"Authorization": f"Bearer {self.cleversee_key}", "Content-Type": "application/json"},
                    json=body,
                )
        except httpx.HTTPError as exc:
            print(f"[Search] CleverSee 异常 {type(exc).__name__}: {exc}")
            return None, time.monotonic() - started
        seconds = time.monotonic() - started
        if response.status_code != 200:
            print(f"[Search] CleverSee HTTP {response.status_code}: {response.text[:200]}")
            return None, seconds
        try:
            return response.json(), seconds
        except ValueError:
            return None, seconds

    @classmethod
    def _format_results(cls, args, engine, items, scenes, notes) -> str:
        lines = [f"[web_search engine={engine} · {len(items)} 条结果]"]
        lines += [f"说明：{note}" for note in notes]
        for scene in scenes:
            block = cls._format_scene(scene)
            if block:
                lines.append(block)
        for index, item in enumerate(items[:RESULTS_PER_SEARCH], 1):
            title = cls._plain(item.get("title"))[:80]
            site = cls._plain(item.get("hostname")) or urlparse(str(item.get("link") or "")).netloc.removeprefix("www.")
            date = str(item.get("publishedTime") or "")[:10]
            meta = " · ".join(part for part in (site, date) if part)
            lines.append(f"{index}. {title}" + (f"（{meta}）" if meta else ""))
            snippet = cls._plain(item.get("snippet"))
            if snippet:
                lines.append(f"   {cls._clip(snippet, SNIPPET_CHARS)}")
            if args["full_text"] and index <= FULL_TEXT_ITEMS:
                body = cls._plain(item.get("mainText"))
                if body:
                    lines.append(f"   正文节选：{cls._clip(body, FULL_TEXT_CHARS)}")
        if len(items) < FEW_RESULTS and not scenes:
            others = [name for name in ENGINES if name != engine]
            lines.append(f"结果较少：可换关键词，或换 engine（{' / '.join(others)}）再搜一次。")
        return "\n".join(lines)

    @classmethod
    def _format_scene(cls, scene: dict[str, Any]) -> str:
        kind = scene.get("type")
        detail = scene.get("detail")
        if isinstance(detail, str):
            try:
                detail = json.loads(detail)
            except ValueError:
                return ""
        if not detail:
            return ""
        if kind == "weather":
            loc = detail.get("location") or {}
            now = detail.get("realtimeData") or {}
            forecast = detail.get("weatherForecastData") or {}
            city = loc.get("district") or loc.get("city") or ""
            out = [f"【天气数据·{city}】实时：{now.get('weather', '')} {now.get('temp', '')}℃，"
                   f"{now.get('windDir', '')}{now.get('windLevel', '')}级，湿度 {now.get('humidity', '')}%"
                   f"，日出 {now.get('sunRise', '')} 日落 {now.get('sunDown', '')}"]
            hours = forecast.get("hourlyForecast") or []
            if hours:
                out.append("逐小时：" + "；".join(
                    f"{h.get('predictHour', '')}时 {h.get('weather', '')} {h.get('temp', '')}℃" for h in hours[:12]))
            for day in (forecast.get("dailyForecast") or [])[:5]:
                weather = day.get("weatherDay", "")
                if day.get("weatherNight") and day.get("weatherNight") != weather:
                    weather = f"{weather}转{day['weatherNight']}"
                out.append(f"{day.get('predictDate', '')}：{weather} {day.get('tempLow', '')}~{day.get('tempHigh', '')}℃，"
                           f"{day.get('windDirDay', '')}{day.get('windLevelDay', '')}")
            return "\n".join(out)
        if kind == "time":
            return f"【时间数据】{detail.get('title', '')} 当前时间 {detail.get('targetTime', '')}"
        if kind == "exchange_rate":
            return (f"【汇率数据】1 {detail.get('from', '')}（{detail.get('fromCode', '')}）= {detail.get('currentValue', '')} "
                    f"{detail.get('to', '')}（{detail.get('toCode', '')}），更新于 {detail.get('updateTime', '')}")
        if kind == "stock_price":
            trade = detail.get("tradingData") or {}
            return (f"【股价数据】{detail.get('stockName', '')}（{detail.get('stockCode', '')}，{detail.get('marketType', '')}）"
                    f" {detail.get('currentPrice', '')}，涨跌 {detail.get('priceChange', '')}（{detail.get('changePercent', '')}），"
                    f"开 {trade.get('openPrice', '')} 高 {trade.get('highPrice', '')} 低 {trade.get('lowPrice', '')}，"
                    f"时间 {detail.get('tradingTime', '')}")
        if kind == "gold_price" and isinstance(detail, list):
            rows = [f"{row.get('productName', '')} {row.get('price', '')}（{row.get('changeValueRatio', '')}）" for row in detail[:6]]
            updated = detail[0].get("updateTime", "") if detail else ""
            return f"【贵金属价格】{'；'.join(rows)}，更新于 {updated}"
        return f"【{kind}数据】{json.dumps(detail, ensure_ascii=False)[:600]}"

    @classmethod
    def _cleversee_sources(cls, items: list[dict[str, Any]]) -> list[dict[str, str]]:
        return cls._normalize_sources([
            {
                "url": item.get("link"),
                "title": cls._plain(item.get("title")),
                "site_name": cls._plain(item.get("hostname")),
                "icon": item.get("hostLogo"),
            }
            for item in items
        ])

    @staticmethod
    def _plain(value: Any) -> str:
        """去掉 <em> 之类的高亮标签和 HTML 实体，压缩空白。"""
        text = html.unescape(TAG_RE.sub("", str(value or "")))
        return SPACE_RE.sub(" ", text).strip()

    @staticmethod
    def _clip(text: str, limit: int) -> str:
        return text if len(text) <= limit else text[:limit].rstrip() + "…"

    # ------------------------------------------------------------------
    # 中转站 Responses API（备用）
    # ------------------------------------------------------------------

    def _search_relay(self, query: str) -> tuple[str, list[dict[str, str]]]:
        cfg = self.llm.get_model_config("search_builtin")
        api_key = self.llm.get_api_key(cfg)
        if not api_key:
            print("[Search] 未配置搜索模型的 API Key")
            return self.FAILED, []

        payload = {
            "model": cfg["model"],
            "instructions": get_search_prompt(),
            "input": query,
            "tools": [{
                "type": "web_search",
                "search_context_size": "medium",
                "user_location": {
                    "type": "approximate",
                    "country": "CN",
                    "city": "Hangzhou",
                    "timezone": "Asia/Shanghai",
                },
            }],
            "tool_choice": "required",
            # 模型不一定每次都在正文里引用；把实际看过的网页也要回来，引用为空时拿它兜底
            "include": ["web_search_call.action.sources"],
            "max_output_tokens": cfg.get("max_tokens", 1200),
        }
        endpoint = self._responses_endpoint(str(cfg.get("api_base") or ""))
        print(f"\n[Search] 中转站搜索: {query}")
        try:
            with build_http_client(httpx.Timeout(connect=20.0, read=90.0, write=20.0, pool=20.0)) as client:
                response = client.post(endpoint, headers=self.llm._build_headers(api_key), json=payload)
            if response.status_code != 200:
                print(f"[Search] HTTP {response.status_code}: {response.text[:200]}")
                return self.FAILED, []
            text, sources = self._parse_response(response.json())
        except (httpx.HTTPError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            print(f"[Search] 异常 {type(exc).__name__}: {exc}")
            return self.FAILED, []
        if not text:
            return self.FAILED, []
        return text, sources

    @staticmethod
    def _responses_endpoint(api_base: str) -> str:
        base = api_base.rstrip("/")
        if not base.endswith("/v1"):
            base = f"{base}/v1"
        return f"{base}/responses"

    @classmethod
    def _parse_response(cls, data: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
        texts: list[str] = []
        raw_sources: list[dict[str, str]] = []
        consulted: list[dict[str, str]] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "web_search_call":
                for src in (item.get("action") or {}).get("sources") or []:
                    if isinstance(src, dict) and src.get("url"):
                        consulted.append({"url": src.get("url"), "title": src.get("title")})
                continue
            if item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                text = str(part.get("text") or "")
                if text:
                    texts.append(text)
                for ann in part.get("annotations") or []:
                    if isinstance(ann, dict) and ann.get("type") == "url_citation":
                        raw_sources.append({"url": ann.get("url"), "title": ann.get("title")})
        text = "\n".join(texts).strip()
        # 正文里的 markdown 链接也算来源（有的上游不给 annotations）
        for title, url in MARKDOWN_LINK_RE.findall(text):
            raw_sources.append({"url": url, "title": title})
        sources = cls._normalize_sources(raw_sources) or cls._normalize_sources(consulted)
        return cls._clean_text(text), sources

    @staticmethod
    def _clean_text(text: str) -> str:
        """给主模型的摘要：链接换成"标题（域名）"，省 token，也避免主模型把追踪参数原样抄给用户。"""
        def replace(match: re.Match) -> str:
            host = urlparse(match.group(2)).netloc.removeprefix("www.")
            return f"{match.group(1)}（{host}）" if host else match.group(1)
        return MARKDOWN_LINK_RE.sub(replace, text).strip()

    @classmethod
    def _normalize_sources(cls, raw) -> list[dict[str, str]]:
        sources: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            url = TRACKING_PARAM_RE.sub("", str(item.get("url") or "").strip()).rstrip("?&")
            if not url.startswith(("http://", "https://")):
                continue
            host = urlparse(url).netloc.removeprefix("www.")
            key = url.split("#")[0]
            if key in seen:
                continue
            seen.add(key)
            site = str(item.get("site_name") or "").strip()
            # 没给图标时直接用站点自己的 favicon；加载失败时前端退回首字母
            icon = str(item.get("icon") or "").strip() or f"{urlparse(url).scheme}://{urlparse(url).netloc}/favicon.ico"
            sources.append({
                "title": (str(item.get("title") or "").strip() or host)[:120],
                "url": url,
                "site": (site if site and site != "无" else host)[:40],
                "icon": icon,
            })
            if len(sources) >= cls.MAX_SOURCES:
                break
        return sources
