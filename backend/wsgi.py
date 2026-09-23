"""
兼容入口：后端已从 Flask 迁到 FastAPI，这里不再是 WSGI 应用。

保留这个文件是为了让服务器上旧的启动命令 `gunicorn -c gunicorn.conf.py wsgi:app` 继续可用，
gunicorn.conf.py 已经把 worker 换成了 uvicorn worker。新部署请改用 `asgi:app`。
不要在这里恢复 gevent 的 monkey.patch_all()，它和 asyncio 事件循环冲突。
"""

from asgi import app

__all__ = ["app"]
