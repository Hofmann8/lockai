"""
Gunicorn 配置文件
适用于 2核2G 服务器，可用内存约 700M
"""

import os

# 绑定地址
bind = os.environ.get("GUNICORN_BIND", "0.0.0.0:5003")

# Worker 配置
workers = int(os.environ.get("GUNICORN_WORKERS", 1))  # 小内存机器用 1 个 worker
worker_class = "gevent"  # 协程模式，支持高并发长连接
worker_connections = int(os.environ.get("GUNICORN_CONNECTIONS", 50))  # 每个 worker 50 并发

# 超时配置（SSE 长连接需要较长超时）
timeout = 120
graceful_timeout = 30
keepalive = 5

# 日志
accesslog = "-"  # stdout
errorlog = "-"   # stderr
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)sμs'

# 进程管理
daemon = False
pidfile = None
preload_app = False  # gevent 不建议 preload

# 安全
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190
