"""
共享 HTTP 客户端

上游中转站偶发在建连阶段断开（实测约 10% 的请求），连接层重试一次即可恢复。
重试只对建连失败生效，已经开始返回内容的请求不会重复发送。
"""

import httpx

CONNECT_RETRIES = 2


def build_http_client(timeout: httpx.Timeout) -> httpx.Client:
    return httpx.Client(timeout=timeout, transport=httpx.HTTPTransport(retries=CONNECT_RETRIES))
