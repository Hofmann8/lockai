"""
WSGI 入口文件
生产环境使用 gunicorn 启动

启动命令（2核2G服务器推荐配置）：
    gunicorn -c gunicorn.conf.py wsgi:app

或直接命令行：
    gunicorn -w 1 -k gevent --worker-connections 50 -b 0.0.0.0:5000 wsgi:app
"""

from app import app

if __name__ == "__main__":
    app.run()
