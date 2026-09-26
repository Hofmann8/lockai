"""
Gunicorn 配置文件（FastAPI / ASGI）
适用于 2核2G 服务器，可用内存约 700M

启动：gunicorn -c gunicorn.conf.py asgi:app
"""

import os

# 绑定地址
bind = os.environ.get("GUNICORN_BIND", "0.0.0.0:5003")

# Worker 配置
# 小内存机器用 1 个 worker。并发靠事件循环 + 线程池：普通接口在线程池里跑，
# SSE 流由后台线程生产、事件循环转发，长连接不会占满 worker。
# 后台回答的注册表（services/runs.py）在进程内存里，必须保持 1 个 worker，否则回来接不上正在跑的回答。
workers = int(os.environ.get("GUNICORN_WORKERS", 1))
worker_class = "uvicorn_worker.UvicornWorker"

# 超时配置
# uvicorn worker 的心跳由事件循环维持，长请求本身不会触发 timeout；
# 这里保留一个宽松值，只用于回收真正卡死的 worker。
# HD 出图的上限见 services/image.py 的 IMAGE_GEN_HD_TIMEOUT（900s）。
timeout = 1200
graceful_timeout = 30
keepalive = 5

# 日志
accesslog = "-"  # stdout
errorlog = "-"   # stderr
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")

# 进程管理
daemon = False
pidfile = None
preload_app = False

# 安全
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190
