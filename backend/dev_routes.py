"""
Dev Monitor Routes - Paper 生成过程的实时监控
/dev/ 下的所有路由，不暴露在主页面，自己访问调试用
"""

import json
import os
from queue import Empty

from flask import Blueprint, request, jsonify, Response, send_from_directory, stream_with_context

from services.terminal import paper_events

dev_bp = Blueprint("dev", __name__, url_prefix="/dev")


@dev_bp.route("/")
def monitor_ui():
    """监控面板页面"""
    return send_from_directory(
        os.path.join(os.path.dirname(__file__), "templates"),
        "dev_terminal.html",
    )


@dev_bp.route("/papers", methods=["GET"])
def list_monitored_papers():
    """列出所有有事件的 paper"""
    paper_ids = paper_events.list_papers()
    result = []
    for pid in paper_ids:
        history = paper_events.get_history(pid)
        last_event = history[-1] if history else {}
        result.append({
            "paper_id": pid,
            "event_count": len(history),
            "last_event_type": last_event.get("type", ""),
            "last_event_ts": last_event.get("ts", 0),
        })
    # 按最后事件时间倒序
    result.sort(key=lambda x: x["last_event_ts"], reverse=True)
    return jsonify(result)


@dev_bp.route("/papers/<paper_id>/events", methods=["GET"])
def get_paper_events(paper_id):
    """获取某个 paper 的所有事件历史"""
    history = paper_events.get_history(paper_id)
    return jsonify(history)


@dev_bp.route("/papers/<paper_id>/stream", methods=["GET"])
def stream_paper_events(paper_id):
    """SSE 流式订阅某个 paper 的事件"""
    include_history = request.args.get("history", "1") == "1"
    q = paper_events.subscribe(paper_id, include_history=include_history)

    def generate():
        try:
            while True:
                try:
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except Empty:
                    # 心跳保活
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except GeneratorExit:
            paper_events.unsubscribe(paper_id, q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@dev_bp.route("/stream", methods=["GET"])
def stream_all_events():
    """SSE 全局事件流 — 接收所有 paper 的事件，用于自动发现新任务"""
    q = paper_events.subscribe_global()

    def generate():
        try:
            while True:
                try:
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except Empty:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except GeneratorExit:
            paper_events.unsubscribe_global(q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
